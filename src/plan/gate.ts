import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { PlanningApiV1, Verdict, Window } from "../oracle/contract";
import type { PassRule } from "../search/passes";
import { berthable } from "../search/fallback";
import { passes } from "../search/passes";
import { isBerth } from "./proof";
import type { Part } from "./stages";

/**
 * Tide gates (plan §4.3): when a route passes only at some states of the tide, the
 * earliest departure, up to the request's latest, at which every leg is passed in water
 * the check passes, as the boat reaches it. The planner never reads a tide table: it asks
 * the planning API about each gated leg over 15-minute windows, at the lowest water in each.
 */

/** The step departures and pass windows are taken in, ms: the water level forecast's. */
export const SLOT_MS = 15 * 60_000;

export interface GateInput {
  departure: number;
  latest: number;
  speed: number;
  probability?: number;
  draft?: number;
}

/** The departure, or why there is none, with the planning API work the timing did. */
export type Timed =
  | { ok: true; departure: number; gated: number[]; work: number }
  | { ok: false; reason: string; work: number };

interface Leg {
  a: LonLat;
  b: LonLat;
  xteLimit?: number;
  /** A berth leg: alongside its quay by design, held only to `berthable`, as the proof holds it. */
  berth?: true;
  /** Time from departure to the leg's start and end, ms. */
  from: number;
  to: number;
}

/** The candidate's legs, in order, with when the boat reaches each after leaving. */
export function legsOf(parts: readonly Part[], speed: number): Leg[] {
  const legs: Leg[] = [];
  let t = 0;
  for (const p of parts) {
    for (let i = 1; i < p.coordinates.length; i++) {
      const a = p.coordinates[i - 1] as LonLat;
      const b = p.coordinates[i] as LonLat;
      const dt = (haversine(a, b) / speed) * 1000;
      legs.push({
        a,
        b,
        ...(p.xteLimit !== undefined && { xteLimit: p.xteLimit }),
        ...(isBerth(p, i - 1) && { berth: true as const }),
        from: t,
        to: t + dt
      });
      t += dt;
    }
  }
  return legs;
}

/**
 * Whether a verdict lets a strict plan through: passing, or marginal. A berth leg touches its
 * quay by design, so as in the proof only a flag `berthable` rejects closes it.
 */
const through = (v: Verdict, rule: PassRule, leg: Leg): boolean =>
  leg.berth ? berthable(v) : passes(v, rule) || v.status === "marginal";

/** The slot windows that cover [from, to), on the grid from `origin`. */
function slotsOver(origin: number, from: number, to: number): number[] {
  const out: number[] = [];
  const first = Math.floor((from - origin) / SLOT_MS);
  for (let k = first; origin + k * SLOT_MS < to; k++) {
    out.push(k);
  }
  return out;
}

const WORK = "timing the departure reached the work limit";

/**
 * Per gated leg, whether each slot of the horizon may be passed (index k: the window from
 * departure + k slots). A leg that passes at the lowest water of the whole horizon is not gated.
 * One session per corridor width, one after another: a session holds the request queue.
 */
async function passWindows(
  api: PlanningApiV1,
  g: GateInput,
  legs: readonly Leg[],
  horizon: Window,
  ctx: { rule: PassRule; signal: AbortSignal; budget: number }
): Promise<{ gated: Map<number, boolean[]>; work: number } | { reason: string; work: number }> {
  const slots = Math.ceil((horizon.end - horizon.start) / SLOT_MS);
  const gated = new Map<number, boolean[]>();
  let work = 0;
  for (const width of new Set(legs.map((l) => l.xteLimit))) {
    const params = {
      departure: horizon.start,
      until: horizon.end,
      speed: g.speed,
      ...(width !== undefined && { xteLimit: width }),
      ...(g.probability !== undefined && { probability: g.probability }),
      ...(g.draft !== undefined && { draft: g.draft })
    };
    const r = await api.session(params, ctx.signal, async (s) => {
      const spent = (): boolean => work + s.work() >= ctx.budget;
      for (const [i, leg] of legs.entries()) {
        if (leg.xteLimit !== width) {
          continue;
        }
        // Every query is within the budget, the full-horizon one included.
        if (spent()) {
          return { stop: WORK, work: s.work() };
        }
        if (through(s.segment(leg.a, leg.b, horizon), ctx.rule, leg)) {
          continue;
        }
        const open: boolean[] = [];
        for (let k = 0; k < slots; k++) {
          if (spent()) {
            return { stop: WORK, work: s.work() };
          }
          const start = horizon.start + k * SLOT_MS;
          const v = s.segment(leg.a, leg.b, { start, end: start + SLOT_MS });
          open.push(through(v, ctx.rule, leg));
          await s.pause();
        }
        gated.set(i, open);
      }
      return { work: s.work() };
    });
    if (!r.ok) {
      return { reason: r.error, work };
    }
    work += r.value.work;
    if (r.value.stop !== undefined) {
      return { reason: r.value.stop, work };
    }
  }
  return { gated, work };
}

/**
 * The earliest departure from `g.departure` to `g.latest`, on the slot grid, at which every
 * gated leg lies in windows it may be passed in, or why there is none. `budget` bounds the
 * planning API's work across the sessions it needs.
 */
export async function timeDeparture(
  api: PlanningApiV1,
  g: GateInput,
  parts: readonly Part[],
  ctx: { rule: PassRule; signal: AbortSignal; budget: number }
): Promise<Timed> {
  const legs = legsOf(parts, g.speed);
  const trip = legs[legs.length - 1]?.to ?? 0;
  const horizon: Window = { start: g.departure, end: g.latest + trip + SLOT_MS };
  const windows = await passWindows(api, g, legs, horizon, ctx);
  if ("reason" in windows) {
    return { ok: false, reason: windows.reason, work: windows.work };
  }
  const { gated: open, work } = windows;
  const gated = [...open.keys()];
  for (let t = g.departure; t <= g.latest; t += SLOT_MS) {
    const clear = gated.every((i) => {
      const leg = legs[i] as Leg;
      const w = open.get(i) as boolean[];
      return slotsOver(g.departure, t + leg.from, t + leg.to).every((k) => w[k] === true);
    });
    if (clear) {
      return { ok: true, departure: t, gated, work };
    }
  }
  return { ok: false, reason: noDeparture(g.latest, gated, open), work };
}

/**
 * Why no departure qualified: the gated legs no window of the horizon opens, if any; else the
 * gated legs, each passable in some window, that no single departure reaches in their windows.
 */
function noDeparture(latest: number, gated: number[], open: Map<number, boolean[]>): string {
  const at = new Date(latest).toISOString();
  const name = (ls: number[]) =>
    `leg${ls.length === 1 ? "" : "s"} ${ls.map((i) => i + 1).join(", ")}`;
  const closed = gated.filter((i) => !(open.get(i) as boolean[]).includes(true));
  return closed.length > 0
    ? `no departure up to ${at} passes ${name(closed)}: no state of the water level the forecast gives opens ${closed.length === 1 ? "it" : "them"}`
    : `no departure up to ${at} passes ${name(gated)} each in a window the check passes it in`;
}
