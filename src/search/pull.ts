import type { LonLat } from "../foundation/geo";
import type { Verdict } from "../oracle/contract";

/**
 * String pulling (plan §4.1 step 4). The path from the quadtree search holds
 * because each of its pieces lies inside one free square; it zig-zags through
 * square centres and edge midpoints. From each kept waypoint, the farthest
 * later point whose straight leg passes the corridor check becomes the next
 * waypoint. Candidates are tried farthest first, then halving the distance
 * in points, so a waypoint costs O(log n) checks; the next point along the
 * path is kept unchecked when no candidate passes, since it lies in the same
 * free square.
 */

export interface PullLimits {
  /** True once pulling has used its work; the remaining points are then kept as they are. */
  exhausted(): boolean;
  pause(): Promise<void>;
}

export async function pull(
  points: readonly LonLat[],
  segment: (a: LonLat, b: LonLat) => Verdict,
  limits: PullLimits
): Promise<LonLat[]> {
  if (points.length <= 2) {
    return [...points];
  }
  const kept: LonLat[] = [points[0] as LonLat];
  let i = 0;
  const last = points.length - 1;
  while (i < last) {
    if (limits.exhausted()) {
      kept.push(...points.slice(i + 1));
      return kept;
    }
    let next = i + 1;
    for (let step = last - i; step > 1; step = Math.ceil(step / 2)) {
      const j = i + step;
      if (segment(points[i] as LonLat, points[j] as LonLat).status === "ok") {
        next = j;
        break;
      }
      if (step === 2) {
        break;
      }
    }
    kept.push(points[next] as LonLat);
    i = next;
    await limits.pause();
  }
  return kept;
}
