import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, haversine, wrapLon } from "../foundation/geo";
import type { PlanningApiV1, Window } from "../oracle/contract";
import type { PassRule } from "../search/passes";
import type { GateInput, Leg } from "./gate";
import { legsOf, passWindows, SLOT_MS, slotsOver, WORK } from "./gate";
import { isBerth } from "./proof";
import type { Part } from "./stages";

/**
 * Waiting en route (plan §4.3, R3b): when no single departure passes every gated leg, the
 * boat may wait for the water on the way, at places along the route with room to swing.
 * A place is one where the planning API finds a box `swing` metres about it `ok`, verified
 * and passing, at the lowest water of the whole horizon, so any wait there is safe. Waiting is
 * FIFO, so the earliest arrival is exact: the search below keeps each time the boat may leave
 * each place that brings a gated leg ahead onto a slot boundary, as signalk-underkeel judges
 * each leg at the lowest water of the slots it is sailed in. The boat waits at most
 * `latest − departure` in all, at the start and on the way.
 */

export interface WaitInput extends GateInput {
  /** Half the side of the box a waiting place must pass, metres: room to swing. */
  swing: number;
  /** Places are tried along each leg this far apart, and at the route's turns, metres. */
  spacing: number;
}

export interface Wait {
  at: LonLat;
  arrive: number;
  leave: number;
}

export type Scheduled =
  | { ok: true; departure: number; waits: Wait[]; parts: Part[]; gated: number[]; work: number }
  /** `stopped`: the timing did not finish (its work limit, or the planning API's error). */
  | { ok: false; reason: string; work: number; stopped?: true };

const DEG = Math.PI / 180;

const along = (a: LonLat, b: LonLat, f: number): LonLat => [
  wrapLon(a[0] + wrapLon(b[0] - a[0]) * f),
  a[1] + (b[1] - a[1]) * f
];

/** The box `r` metres about `p`: south-west and north-east corners. */
function boxAbout(p: LonLat, r: number): [LonLat, LonLat] {
  const dLat = r / (EARTH_RADIUS * DEG);
  const dLon = dLat / Math.max(Math.cos(p[1] * DEG), 1e-6);
  return [
    [wrapLon(p[0] - dLon), p[1] - dLat],
    [wrapLon(p[0] + dLon), p[1] + dLat]
  ];
}

interface Refined {
  parts: Part[];
  /** Per part, per coordinate: a point added on a leg, not one of the route's own. */
  added: boolean[][];
}

/** `parts` with a point every `spacing` metres along each leg, berth legs left whole. */
function refine(parts: readonly Part[], spacing: number): Refined {
  const out: Part[] = [];
  const added: boolean[][] = [];
  for (const p of parts) {
    const c = p.coordinates;
    const coords: LonLat[] = [c[0] as LonLat];
    const flags = [false];
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1] as LonLat;
      const b = c[i] as LonLat;
      const n = isBerth(p, i - 1) ? 1 : Math.max(1, Math.ceil(haversine(a, b) / spacing));
      for (let k = 1; k < n; k++) {
        coords.push(along(a, b, k / n));
        flags.push(true);
      }
      coords.push(b);
      flags.push(false);
    }
    out.push({ ...p, coordinates: coords });
    added.push(flags);
  }
  return { parts: out, added };
}

/**
 * Per leg of `legs`, whether the boat may wait at its start: an inner point of the route,
 * neither end nor inside a berth leg, whose swing box passes at the horizon's lowest water.
 */
async function waitingPlaces(
  api: PlanningApiV1,
  g: WaitInput,
  legs: readonly Leg[],
  horizon: Window,
  ctx: { rule: PassRule; signal: AbortSignal; budget: number }
): Promise<{ places: boolean[]; work: number } | { reason: string; work: number }> {
  let spent = 0;
  const params = {
    departure: horizon.start,
    until: horizon.end,
    speed: g.speed,
    ...(g.probability !== undefined && { probability: g.probability }),
    ...(g.draft !== undefined && { draft: g.draft })
  };
  const r = await api.session(params, ctx.signal, async (s) => {
    try {
      const places: boolean[] = [];
      for (const [j, leg] of legs.entries()) {
        const inner = j > 0 && !leg.berth && !(legs[j - 1] as Leg).berth;
        if (!inner) {
          places.push(false);
          continue;
        }
        if (s.work() >= ctx.budget) {
          return WORK;
        }
        const [sw, ne] = boxAbout(leg.a, g.swing);
        // Verified water alone: no flag the request accepts makes a wait in unchecked water safe.
        places.push(s.box(sw, ne, horizon).status === "ok");
        await s.pause();
      }
      return places;
    } finally {
      spent = s.work();
    }
  });
  if (!r.ok) {
    return { reason: r.error, work: spent };
  }
  return typeof r.value === "string"
    ? { reason: r.value, work: spent }
    : { places: r.value, work: spent };
}

/** A time the boat leaves a place at, and how it got there. */
interface Leave {
  leave: number;
  arrive: number;
  /** The leave at the place before, by index into that place's list; -1 at the start. */
  from: number;
  /** The departure the boat left the start at: a later one waits less at sea. */
  departure: number;
}

/**
 * Times built up leg by leg are sums of floating-point sailing times: a leg meant to start on a
 * slot boundary can land a few microseconds before it. Under a millisecond it is on it.
 */
const ON_BOUNDARY_MS = 1;

/** Whether `leg` is open from `t`: not gated, or every slot it is sailed in passes it. */
function open(origin: number, leg: Leg, t: number, w: readonly boolean[] | undefined): boolean {
  if (!w) {
    return true;
  }
  const d = leg.to - leg.from;
  return slotsOver(origin, t + ON_BOUNDARY_MS, t + d).every((k) => w[k] === true);
}

/**
 * The times the boat may leave each place: forced on from the place before where it may not
 * wait, else also each slot boundary after an arrival, up to the wait it has left. Of the
 * ways to one time, the one that left the start latest is kept: it waits least at sea.
 */
function leaves(
  g: WaitInput,
  legs: readonly Leg[],
  places: readonly boolean[],
  gated: Map<number, boolean[]>,
  origin: number
): Leave[][] {
  const starts: Leave[] = [];
  for (let t = g.departure; t <= g.latest; t += SLOT_MS) {
    starts.push({ leave: t, arrive: g.departure, from: -1, departure: t });
  }
  const out: Leave[][] = [starts];
  for (let j = 1; j < legs.length; j++) {
    const here = arrivals(out[j - 1] as Leave[], legs[j - 1] as Leg, gated.get(j - 1), origin);
    if (places[j] === true && here.length > 0) {
      // The boat waits at most `latest − departure` in all, so it leaves by then plus its sailing.
      waitsAfter(here, g.latest + (legs[j] as Leg).from, origin, offsets(legs, places, gated, j));
    }
    out.push(here);
    if (here.length === 0) {
      break;
    }
  }
  return out;
}

/** The arrivals at the end of `leg` from the times it may be left at, earliest first. */
function arrivals(
  before: readonly Leave[],
  leg: Leg,
  w: readonly boolean[] | undefined,
  origin: number
): Leave[] {
  const sailed = leg.to - leg.from;
  const byArrival = new Map<number, Leave>();
  before.forEach((l, i) => {
    if (!open(origin, leg, l.leave, w)) {
      return;
    }
    const arrive = l.leave + sailed;
    const seen = byArrival.get(arrive);
    if (!seen || l.departure > seen.departure) {
      byArrival.set(arrive, { leave: arrive, arrive, from: i, departure: l.departure });
    }
  });
  return [...byArrival.values()].sort((a, b) => a.arrive - b.arrive);
}

/**
 * The sailing times from place `j` to the start of each gated leg before the next place the
 * boat may wait at. A leg is opened as its start passes a slot boundary, so the earliest time
 * to leave `j` that opens them all brings one of them onto a boundary.
 */
function offsets(
  legs: readonly Leg[],
  places: readonly boolean[],
  gated: ReadonlyMap<number, boolean[]>,
  j: number
): number[] {
  const out = new Set<number>([0]);
  const from = (legs[j] as Leg).from;
  for (let k = j; k < legs.length && (k === j || places[k] !== true); k++) {
    if (gated.has(k)) {
      out.add((legs[k] as Leg).from - from);
    }
  }
  return [...out];
}

/**
 * Adds to `here` (arrivals, earliest first) leaving at each time up to `last`, after one, that
 * brings a gated leg ahead onto a slot boundary (`offsets`).
 */
function waitsAfter(here: Leave[], last: number, origin: number, ahead: readonly number[]): void {
  const direct = new Set(here.map((l) => l.leave));
  const first = (here[0] as Leave).arrive;
  const times = new Set<number>();
  for (const d of ahead) {
    for (let k = Math.floor((first + d - origin) / SLOT_MS) + 1; ; k++) {
      const t = origin + k * SLOT_MS - d;
      if (t > last) {
        break;
      }
      if (t > first && !direct.has(t)) {
        times.add(t);
      }
    }
  }
  const n = here.length;
  let best: Leave | undefined;
  let next = 0;
  for (const t of [...times].sort((a, b) => a - b)) {
    while (next < n && (here[next] as Leave).arrive < t) {
      const a = here[next] as Leave;
      if (!best || a.departure > best.departure) {
        best = a;
      }
      next++;
    }
    if (best) {
      here.push({ ...best, leave: t });
    }
  }
}

/**
 * The route's parts again with the waits: the points added on its legs dropped but those it
 * waits at, and each part split where the boat waits, the piece after a wait carrying it. A
 * split harbour part keeps its end and berth on the piece at that end.
 */
function withWaits(refined: Refined, waitAt: ReadonlyMap<number, number>): Part[] {
  const out: Part[] = [];
  let before = 0;
  refined.parts.forEach((p, pi) => {
    const flags = refined.added[pi] as boolean[];
    const n = p.coordinates.length;
    let coords: LonLat[] = [p.coordinates[0] as LonLat];
    let wait = pi > 0 ? waitAt.get(before) : undefined;
    let firstPiece = true;
    const push = (last: boolean): void => {
      const { wait: _, ...rest } = p;
      const piece: Part = { ...rest, coordinates: coords, ...(wait !== undefined && { wait }) };
      if ((p.end === "start" && !firstPiece) || (p.end === "end" && !last)) {
        delete piece.end;
        delete piece.berth;
      }
      out.push(piece);
      firstPiece = false;
    };
    for (let i = 1; i < n; i++) {
      const w = i < n - 1 ? waitAt.get(before + i) : undefined;
      if (w === undefined && flags[i] === true) {
        continue;
      }
      coords.push(p.coordinates[i] as LonLat);
      if (w !== undefined) {
        push(false);
        coords = [p.coordinates[i] as LonLat];
        wait = w;
      }
    }
    push(true);
    before += n - 1;
  });
  return out;
}

/**
 * The earliest arrival, waiting where the route has room to swing, with its departure and
 * waits; or why there is none. `budget` bounds the planning API's work across its sessions.
 */
export async function scheduleWithWaits(
  api: PlanningApiV1,
  g: WaitInput,
  parts: readonly Part[],
  ctx: { rule: PassRule; signal: AbortSignal; budget: number }
): Promise<Scheduled> {
  const refined = refine(parts, g.spacing);
  const legs = legsOf(refined.parts, g.speed);
  const trip = legs[legs.length - 1]?.to ?? 0;
  const origin = g.departure;
  const horizon: Window = { start: origin, end: g.latest + trip + SLOT_MS };
  const placed = await waitingPlaces(api, g, legs, horizon, ctx);
  if ("reason" in placed) {
    return { ok: false, reason: placed.reason, work: placed.work, stopped: true };
  }
  let work = placed.work;
  const windows = await passWindows(api, g, legs, horizon, { ...ctx, budget: ctx.budget - work });
  work += windows.work;
  if ("reason" in windows) {
    return { ok: false, reason: windows.reason, work, stopped: true };
  }
  const { gated } = windows;
  const table = leaves(g, legs, placed.places, gated, origin);
  const best = earliest(table, legs, gated, origin);
  if (best === undefined) {
    return { ok: false, reason: noSchedule(g.latest, placed.places), work };
  }
  const { departure, waits, waitAt } = traced(table, legs, best);
  const out = withWaits(refined, waitAt);
  return {
    ok: true,
    departure,
    waits,
    parts: out,
    gated: offeredLegs(out, legs, gated, g.speed),
    work
  };
}

/** The leave at the last place that arrives earliest, leaving the start latest among those. */
function earliest(
  table: readonly Leave[][],
  legs: readonly Leg[],
  gated: ReadonlyMap<number, boolean[]>,
  origin: number
): number | undefined {
  const lastLeg = legs.length - 1;
  const end = legs[lastLeg] as Leg;
  if (table.length !== legs.length) {
    return undefined;
  }
  let best: { i: number; arrive: number; departure: number } | undefined;
  (table[lastLeg] as Leave[]).forEach((l, i) => {
    if (!open(origin, end, l.leave, gated.get(lastLeg))) {
      return;
    }
    const arrive = l.leave + (end.to - end.from);
    if (!best || arrive < best.arrive || (arrive === best.arrive && l.departure > best.departure)) {
      best = { i, arrive, departure: l.departure };
    }
  });
  return best?.i;
}

/** Back from the leave `i` at the last place: the departure and the waits on the way. */
function traced(
  table: readonly Leave[][],
  legs: readonly Leg[],
  i: number
): { departure: number; waits: Wait[]; waitAt: Map<number, number> } {
  const waits: Wait[] = [];
  const waitAt = new Map<number, number>();
  let k = i;
  for (let j = legs.length - 1; j > 0; j--) {
    const l = (table[j] as Leave[])[k] as Leave;
    if (l.leave > l.arrive) {
      waits.unshift({ at: (legs[j] as Leg).a, arrive: l.arrive, leave: l.leave });
      waitAt.set(j, l.leave - l.arrive);
    }
    k = l.from;
  }
  return { departure: ((table[0] as Leave[])[k] as Leave).leave, waits, waitAt };
}

function noSchedule(latest: number, places: readonly boolean[]): string {
  const n = places.filter(Boolean).length;
  const at = new Date(latest).toISOString();
  return n === 0
    ? `no departure up to ${at} passes every gated leg, and the route has no place with room to swing to wait at`
    : `no departure up to ${at} passes every gated leg, waiting at any of the route's ${String(n)} places with room to swing`;
}

/** The legs of `parts` that hold the gated legs among `legs` (the route with points added). */
function offeredLegs(
  parts: readonly Part[],
  legs: readonly Leg[],
  gated: ReadonlyMap<number, boolean[]>,
  speed: number
): number[] {
  const offered = legsOf(parts, speed);
  const at = new Set<number>();
  for (const j of gated.keys()) {
    // The offered leg the gated leg's middle lies on, by sailing time from the start.
    const mid = ((legs[j] as Leg).from + (legs[j] as Leg).to) / 2;
    const k = offered.findIndex((l) => l.from <= mid && mid < l.to);
    at.add(k < 0 ? offered.length - 1 : k);
  }
  return [...at].sort((a, b) => a - b);
}
