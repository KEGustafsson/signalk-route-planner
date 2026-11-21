import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, haversine, wrapLon } from "../foundation/geo";
import type { ChartObject, Session, Window } from "../oracle/contract";
import type { Leg } from "./gate";

/**
 * Where the boat may wait (plan §4.3): at the route's own points with room to swing, and at
 * designated places, a charted anchorage (`ACHARE`) or a waiting point the user gives, on the
 * route or off it within reach, joined to the route by a short detour out and back. Every
 * place passes a box with room to swing, and every detour passes, at the lowest water of the
 * whole horizon, so any wait there, and the way to it, is safe.
 */

export type PlaceKind = "route" | "anchorage" | "user";

export interface Designated {
  at: LonLat;
  kind: Exclude<PlaceKind, "route">;
  /** From the route's point to the place, metres; 0 on the route. */
  detour: number;
}

/**
 * Per leg start: whether the boat may wait there on the route, and the designated places it
 * may go to: the one it would rather wait at, and the nearest, which any schedule the other
 * allows also allows.
 */
export interface Place {
  onRoute: boolean;
  designated?: Designated;
  nearest?: Designated;
}

/** A place one schedule may wait at: where, how long the detour takes there and back, ms. */
export interface PassPlace {
  at: LonLat;
  kind: PlaceKind;
  detourMs: number;
}

/** Anchoring prohibited (1) or restricted (2), S-57 `RESTRN`. */
const NO_ANCHORING = new Set([1, 2]);

const DEG = Math.PI / 180;

/** The box `r` metres about `p`: south-west and north-east corners. */
export function boxAbout(p: LonLat, r: number): [LonLat, LonLat] {
  const dLat = r / (EARTH_RADIUS * DEG);
  const dLon = dLat / Math.max(Math.cos(p[1] * DEG), 1e-6);
  return [
    [wrapLon(p[0] - dLon), p[1] - dLat],
    [wrapLon(p[0] + dLon), p[1] + dLat]
  ];
}

function inRing(p: LonLat, ring: readonly LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as LonLat;
    const [xj, yj] = ring[j] as LonLat;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Whether `p` lies in a polygon given as its rings, the outer one first. */
export function inPolygon(p: LonLat, rings: readonly (readonly LonLat[])[]): boolean {
  const [outer, ...holes] = rings;
  return outer !== undefined && inRing(p, outer) && !holes.some((h) => inRing(p, h));
}

/** The mean of a ring's vertices, if it lies in the polygon: a point to wait at inside it. */
function centreOf(rings: readonly (readonly LonLat[])[]): LonLat | undefined {
  const outer = rings[0];
  if (!outer || outer.length < 3) {
    return undefined;
  }
  const open = outer.slice(0, -1);
  const c: LonLat = [
    open.reduce((s, q) => s + q[0], 0) / open.length,
    open.reduce((s, q) => s + q[1], 0) / open.length
  ];
  return inPolygon(c, rings) ? c : undefined;
}

/** The anchorage areas a session lists about the route, each polygon its rings. */
function anchorages(s: Session, legs: readonly Leg[], reach: number): LonLat[][][] {
  if (!s.objects || legs.length === 0) {
    return [];
  }
  const points = legs.map((l) => l.a);
  const [sw] = boxAbout(
    [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))],
    reach
  );
  const [, ne] = boxAbout(
    [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))],
    reach
  );
  let objects: ChartObject[];
  try {
    objects = s.objects(sw, ne);
  } catch (err) {
    // A region too large to list waits at the route's own places: anchorages only add places.
    if (err instanceof RangeError) {
      return [];
    }
    throw err;
  }
  return objects
    .filter((o) => o.class === "ACHARE" && o.geometry.type === "MultiPolygon")
    .filter((o) => !(o.restrictions ?? []).some((r) => NO_ANCHORING.has(r)))
    .flatMap((o) => o.geometry.coordinates as LonLat[][][]);
}

const rank = (d: Designated): number => (d.kind === "user" ? 0 : d.detour === 0 ? 1 : 2);

/**
 * Whether `d` is a better place to wait at than `seen`: a user's point first, then an anchorage
 * on the route, then one off it, and of those the nearer.
 */
function better(d: Designated, seen: Designated | undefined): boolean {
  return !seen || rank(d) < rank(seen) || (rank(d) === rank(seen) && d.detour < seen.detour);
}

/** Whether `d` is nearer the route than `seen`, the better of two as near. */
function nearer(d: Designated, seen: Designated | undefined): boolean {
  return !seen || d.detour < seen.detour || (d.detour === seen.detour && better(d, seen));
}

export interface PlaceInput {
  swing: number;
  /** Designated places this far off the route are reached by a detour, metres. */
  reach: number;
  /** The user's waiting points. */
  points: readonly LonLat[];
}

/**
 * Per leg of `legs`, where the boat may wait at its start. Only inner points of the route, at
 * neither end nor beside a berth leg, are places, and a designated place off the route is
 * joined to the nearest of them within `reach`. `null`: the work ran out.
 */
export async function placesAlong(
  s: Session,
  legs: readonly Leg[],
  horizon: Window,
  input: PlaceInput,
  budget: number
): Promise<Place[] | null> {
  const ok = (sw: LonLat, ne: LonLat): boolean => s.box(sw, ne, horizon).status === "ok";
  const inner = legs.map((leg, j) => j > 0 && !leg.berth && !(legs[j - 1] as Leg).berth);
  const areas = anchorages(s, legs, input.reach);
  const places: Place[] = [];
  for (const [j, leg] of legs.entries()) {
    if (!inner[j]) {
      places.push({ onRoute: false });
      continue;
    }
    if (s.work() >= budget) {
      return null;
    }
    // Verified water alone: no flag the request accepts makes a wait in unchecked water safe.
    const onRoute = ok(...boxAbout(leg.a, input.swing));
    const inArea = onRoute && areas.some((rings) => inPolygon(leg.a, rings));
    const here: Designated = { at: leg.a, kind: "anchorage", detour: 0 };
    places.push({ onRoute, ...(inArea && { designated: here, nearest: here }) });
    await s.pause();
  }
  const offRoute: Designated[] = [
    ...input.points.map((at) => ({ at, kind: "user" as const, detour: 0 })),
    ...areas.flatMap((rings) => {
      const at = centreOf(rings);
      return at ? [{ at, kind: "anchorage" as const, detour: 0 }] : [];
    })
  ];
  for (const d of offRoute) {
    if ((await join(s, { legs, inner, places, horizon, input, budget }, d)) === null) {
      return null;
    }
  }
  return places;
}

/**
 * Joins the designated place `d` to the nearest inner point of the route within reach, when it
 * is better or nearer than those there and it and the way to it pass. Each place that passes
 * is weighed, not only the one ranked first: one refused at lower water must not hide another,
 * or a plan could pass at low water and be refused at high. `null`: the work ran out.
 */
async function join(
  s: Session,
  w: {
    legs: readonly Leg[];
    inner: readonly boolean[];
    places: Place[];
    horizon: Window;
    input: PlaceInput;
    budget: number;
  },
  d: Designated
): Promise<true | null> {
  const near = nearest(w.legs, w.inner, d.at, w.input.reach);
  if (near === undefined) {
    return true;
  }
  const place = w.places[near.j] as Place;
  // On the route only where the route's own point has room to swing; else the way there passes.
  const candidate: Designated = { ...d, detour: near.d < 1 && place.onRoute ? 0 : near.d };
  const preferred = better(candidate, place.designated);
  const closer = nearer(candidate, place.nearest);
  if (!preferred && !closer) {
    return true;
  }
  if (s.work() >= w.budget) {
    return null;
  }
  const a = (w.legs[near.j] as Leg).a;
  const reached =
    s.box(...boxAbout(d.at, w.input.swing), w.horizon).status === "ok" &&
    (candidate.detour === 0 || s.segment(a, d.at, w.horizon).status === "ok");
  if (reached) {
    const kept = candidate.detour === 0 ? { ...candidate, at: a } : candidate;
    if (preferred) {
      place.designated = kept;
    }
    if (closer) {
      place.nearest = kept;
    }
  }
  await s.pause();
  return true;
}

/** The inner leg start nearest `p` within `reach` metres, and how far it is. */
function nearest(
  legs: readonly Leg[],
  inner: readonly boolean[],
  p: LonLat,
  reach: number
): { j: number; d: number } | undefined {
  let best: { j: number; d: number } | undefined;
  legs.forEach((leg, j) => {
    if (!inner[j]) {
      return;
    }
    const d = haversine(leg.a, p);
    if (d <= reach && (!best || d < best.d)) {
      best = { j, d };
    }
  });
  return best;
}

/**
 * The places one schedule may wait at. `designated`: only charted anchorages and the user's
 * points; else the route's own places too, a place on the route before a detour off it.
 * `nearest`: of the designated places, the nearest rather than the one ranked first.
 */
export function passPlaces(
  places: readonly Place[],
  designated: boolean,
  legs: readonly Leg[],
  speed: number,
  nearest = false
): (PassPlace | undefined)[] {
  return places.map((p, j) => {
    const at = (legs[j] as Leg | undefined)?.a;
    if (!designated && p.onRoute && at) {
      return { at, kind: "route", detourMs: 0 };
    }
    const d = nearest ? p.nearest : p.designated;
    return d ? { at: d.at, kind: d.kind, detourMs: ((2 * d.detour) / speed) * 1000 } : undefined;
  });
}

export const hasDesignated = (places: readonly Place[]): boolean =>
  places.some((p) => p.designated !== undefined);

/** Whether some point's nearest designated place is not the one ranked first there. */
export const nearestDiffers = (places: readonly Place[]): boolean =>
  places.some((p) => p.nearest !== p.designated);
