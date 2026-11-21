import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { PlanningApiV1, Session, Verdict, Window } from "../oracle/contract";
import { crossable } from "../search/fallback";

/**
 * The route passable now (plan §4.3, R3d): the search asks about each square and leg at the
 * water of the time the boat can be there, not at the lowest water of the whole trip.
 *
 * On any route at most `reach` metres long, the boat is at a point p no earlier than it could
 * sail the straight line from the start to p, and no later than the latest departure plus the
 * route less the straight line from p to the destination: whatever the route, the rest of it is
 * at least that line. String pulling only shortens a route, so it keeps every point inside
 * those bounds. A square or leg is asked about the water over that window alone, which lies
 * within the trip's, so it passes wherever the trip-wide question passed it, and more often.
 * The bounds widen by `slack`, a boat that much faster or slower than planned.
 */
export interface Timing {
  from: LonLat;
  to: LonLat;
  /** The departure, and the latest one the request may wait for, epoch ms. */
  departure: number;
  latest: number;
  /** m/s. */
  speed: number;
  /** The longest route the windows hold for, metres. */
  reach: number;
  slack: number;
  /** The session's own window: no window asked for reaches past it. */
  whole: Window;
}

const MINUTE = 60_000;

/** The point of the box sw–ne nearest `p`; a box across the antimeridian has none. */
function nearestIn(p: LonLat, sw: LonLat, ne: LonLat): LonLat | undefined {
  if (sw[0] > ne[0]) {
    return undefined;
  }
  return [Math.min(Math.max(p[0], sw[0]), ne[0]), Math.min(Math.max(p[1], sw[1]), ne[1])];
}

/**
 * The window the boat can be in the box sw–ne in, `margin` metres about it, on a route of at
 * most `t.reach`; the session's whole window when the box lies beyond that reach.
 */
export function arrivalWindow(t: Timing, sw: LonLat, ne: LonLat, margin: number): Window {
  const nearFrom = nearestIn(t.from, sw, ne);
  const nearTo = nearestIn(t.to, sw, ne);
  if (!nearFrom || !nearTo) {
    return t.whole;
  }
  const fromStart = Math.max(0, haversine(t.from, nearFrom) - margin);
  const toEnd = Math.max(0, haversine(t.to, nearTo) - margin);
  const fast = t.speed * (1 + t.slack);
  const slow = t.speed / (1 + t.slack);
  const start = t.departure + (fromStart / fast) * 1000;
  const end = t.latest + ((t.reach - toEnd) / slow) * 1000;
  if (end <= start) {
    // No route within the reach passes here: the trip's own question, as before.
    return t.whole;
  }
  return {
    start: Math.max(t.whole.start, Math.floor(start / MINUTE) * MINUTE),
    end: Math.min(t.whole.end, Math.ceil(end / MINUTE) * MINUTE)
  };
}

const boundsOf = (a: LonLat, b: LonLat): [LonLat, LonLat] => [
  [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
  [Math.max(a[0], b[0]), Math.max(a[1], b[1])]
];

/**
 * Whether the water at another time could change `v`: water the check does not pass, or passes
 * only at some risk, for its depth alone (or a bridge's clearance), with no flag a water level
 * leaves as it is, such as land, no chart or a closed area.
 */
export const waterBound = (v: Verdict): boolean =>
  (v.status !== "ok" || v.risk > 0) &&
  crossable({ flags: v.flags.filter((f) => f !== "AIR_DRAFT") });

/**
 * What timed sessions met: how many verdicts another time's water could change, and each
 * question's verdict by the question. A later, tighter search reuses the verdicts no water
 * changes: water that passed over a window passes over any part of it, and land stays land.
 */
export interface Met {
  waterBound: number;
  known: Map<string, Verdict>;
}

export const newMet = (): Met => ({ waterBound: 0, known: new Map() });

const keyOf = (kind: string, r: number, a: LonLat, b: LonLat): string =>
  `${kind}|${String(r)}|${a.join(",")}|${b.join(",")}`;

/**
 * `s` asking each box and leg it is not given a window for at its arrival window under `t`,
 * recording in `met` what it was told, and answering from `reuse` a question it already holds
 * a verdict for that no water changes.
 */
export function timedSession(s: Session, t: Timing, met?: Met, reuse?: Met): Session {
  const ask = (key: string, query: () => Verdict): Verdict => {
    const held = reuse?.known.get(key);
    if (held && !waterBound(held)) {
      return held;
    }
    const v = query();
    if (met) {
      met.known.set(key, v);
      if (waterBound(v)) {
        met.waterBound++;
      }
    }
    return v;
  };
  const r = s.halfWidth;
  return {
    halfWidth: r,
    box: (sw, ne, window) =>
      window
        ? s.box(sw, ne, window)
        : ask(keyOf("b", r, sw, ne), () => s.box(sw, ne, arrivalWindow(t, sw, ne, r))),
    segment: (a, b, window) =>
      window
        ? s.segment(a, b, window)
        : ask(keyOf("s", r, a, b), () => s.segment(a, b, arrivalWindow(t, ...boundsOf(a, b), r))),
    ...(s.objects && { objects: s.objects.bind(s) }),
    work: () => s.work(),
    pause: () => s.pause(),
    ...(s.within && { within: s.within })
  };
}

/** `api` whose sessions are timed by `t` (with the session's own window as its whole). */
export function timedApi(
  api: PlanningApiV1,
  t: Omit<Timing, "whole">,
  met?: Met,
  reuse?: Met
): PlanningApiV1 {
  return {
    version: 1,
    provider: api.provider,
    ...(api.features && { features: api.features }),
    unavailable: () => api.unavailable(),
    coverage: () => api.coverage(),
    defaults: () => api.defaults(),
    session: (params, signal, job) =>
      api.session(params, signal, (s) =>
        job(
          timedSession(
            s,
            { ...t, whole: { start: params.departure, end: params.until } },
            met,
            reuse
          )
        )
      ),
    routeCheck: (body, signal) => api.routeCheck(body, signal)
  };
}
