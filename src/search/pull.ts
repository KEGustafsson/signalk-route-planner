import type { LonLat } from "../foundation/geo";
import type { Verdict } from "../oracle/contract";
import type { PassRule } from "./passes";
import { OK_ONLY, passes } from "./passes";

/**
 * String pulling (plan §4.1 step 4). The path from the quadtree search holds
 * because each of its pieces lies inside one free square; it zig-zags through
 * square centres and edge midpoints. From each kept waypoint, later points are
 * tried farthest first, then halving the distance in points, and the first
 * whose straight leg passes (`passes.ts`) becomes the next waypoint. This is a
 * bounded heuristic, O(log n) checks a waypoint: it samples the shortcuts and
 * can miss a longer one that passes after a shorter one failed. The next point
 * along the path is kept unchecked when no candidate passes, since it lies in
 * the same free square. With `priced`, every candidate is tried and the cheapest taken.
 */

export interface PullLimits {
  /** True once pulling has used its work; pulling then stops and reports it. */
  exhausted(): boolean;
  pause(): Promise<void>;
}

/** Whether the leg from point i to point j, with verdict v, may replace the path between them. */
export type Shortcut = (v: Verdict, i: number, j: number) => boolean;

/**
 * Pulling by cost: a shortcut is taken when `accept` holds, and of those tried from a waypoint
 * the one whose `score` (its cost and the path's on from j) is lowest, not the farthest.
 */
export interface Priced {
  accept: Shortcut;
  score(v: Verdict, i: number, j: number): number;
}

export async function pull(
  points: readonly LonLat[],
  segment: (a: LonLat, b: LonLat) => Verdict,
  limits: PullLimits,
  rule: PassRule = OK_ONLY,
  also?: Shortcut,
  priced?: Priced
): Promise<LonLat[] | "work"> {
  if (points.length <= 2) {
    return [...points];
  }
  const kept: LonLat[] = [points[0] as LonLat];
  let i = 0;
  const last = points.length - 1;
  while (i < last) {
    let next = i + 1;
    let best = Infinity;
    for (let step = last - i; step > 1; step = Math.ceil(step / 2)) {
      if (limits.exhausted()) {
        return "work";
      }
      const j = i + step;
      const v = segment(points[i] as LonLat, points[j] as LonLat);
      if (priced) {
        const score = priced.accept(v, i, j) ? priced.score(v, i, j) : Infinity;
        if (score < best) {
          best = score;
          next = j;
        }
      } else if (passes(v, rule) || (also?.(v, i, j) ?? false)) {
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
