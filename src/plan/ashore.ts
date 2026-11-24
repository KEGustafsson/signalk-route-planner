import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { Session } from "../oracle/contract";

/**
 * The way off land of a point put on it (plan §4.1, berth legs): a destination clicked on the
 * shore of a harbour lies on land, and its berth leg first runs ashore to the water.
 */

export /** The point `d` metres from `p` toward `q`; short distances, so linear in degrees. */
function toward(p: LonLat, q: LonLat, d: number): LonLat {
  const t = Math.min(1, d / Math.max(haversine(p, q), 1e-9));
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/** The step a berth leg's way off land is walked in, and how far at most, metres. */
const ASHORE_STEP = 5;
const ASHORE_MAX = 200;

/**
 * How far from `p` toward `q` the way runs on land, metres: to the first point, every
 * ASHORE_STEP, whose box at the session's corridor reaches no land (`LAND`). 0 for a point in
 * the water; at most ASHORE_MAX, or the way to `q`.
 */
export function ashore(session: Session, p: LonLat, q: LonLat, exhausted: () => boolean): number {
  const length = Math.min(ASHORE_MAX, haversine(p, q));
  for (let d = 0; d <= length; d += ASHORE_STEP) {
    if (exhausted()) {
      return 0;
    }
    const at = toward(p, q, d);
    if (!session.box(at, at).flags.includes("LAND")) {
      return d;
    }
  }
  return length;
}
