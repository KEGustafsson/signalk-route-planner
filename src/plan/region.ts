import type { LonLat } from "../foundation/geo";
import { frameAt, haversine, midpoint } from "../foundation/geo";
import type { Bbox } from "../oracle/contract";
import type { TreeShape } from "../search/quadtree";
import { MAX_BOX_KM2 } from "../search/quadtree";
import type { PlanOptions } from "./options";

/** The search's region (plan §4.1): the quadtree's square, its frame and its smallest squares. */

/** A box with its corridor buffer at the frame's origin stays under MAX_BOX_KM2. */
const MAX_BOX_SIDE = Math.sqrt(MAX_BOX_KM2 * 1e6);

const pow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/**
 * The quadtree's shape around start and goal, or why there is none: the square around their
 * midpoint, or the square around `within`'s boxes (a corridor's, `Session.within`) when that is
 * smaller, as past them the chart reads no coverage. The smaller the square, the finer its
 * smallest squares.
 */
export function shapeFor(
  from: LonLat,
  to: LonLat,
  halfWidth: number,
  opts: PlanOptions,
  within?: readonly Bbox[]
): TreeShape | string {
  const d = haversine(from, to);
  const half = d / 2 + Math.max(d / 2, opts.minMargin);
  const corridor = within && within.length > 0 ? squareAround(within, [from, to]) : undefined;
  return corridor && corridor.half < half
    ? regionShape(corridor.middle, corridor.half, halfWidth, opts)
    : regionShape(midpoint(from, to), half, halfWidth, opts);
}

/** The square around `boxes` and `points` in the frame at its middle: middle and half side, metres. */
function squareAround(
  boxes: readonly Bbox[],
  points: readonly LonLat[]
): { middle: LonLat; half: number } {
  const lons = [...boxes.flatMap((b) => [b[0], b[2]]), ...points.map((p) => p[0])];
  const lats = [...boxes.flatMap((b) => [b[1], b[3]]), ...points.map((p) => p[1])];
  const [w, e, s, n] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const middle: LonLat = [(w + e) / 2, (s + n) / 2];
  const frame = frameAt(middle);
  const half = Math.max(...frame.toXY([e, n]).map(Math.abs), ...frame.toXY([w, s]).map(Math.abs));
  return { middle, half };
}

/** The quadtree's shape for the square of half side `half` metres around `middle`, or why there is none. */
export function regionShape(
  middle: LonLat,
  half: number,
  halfWidth: number,
  opts: PlanOptions
): TreeShape | string {
  let unit = Math.max(opts.minCell, halfWidth / 2);
  while (pow2((2 * half) / unit) > opts.maxSideUnits) {
    unit *= 2;
  }
  const side = pow2((2 * half) / unit);
  const leafMetres = Math.min(opts.maxLeafMetres, MAX_BOX_SIDE - 2 * halfWidth);
  if (leafMetres < unit) {
    return `the corridor half-width ${Math.round(halfWidth)} m is too wide to plan in`;
  }
  const maxLeaf = 2 ** Math.floor(Math.log2(leafMetres / unit));
  const extent = (side * unit) / 2;
  const frame = frameAt(middle);
  // Planning API v1 boxes are west–east corner pairs: none may cross the 180° meridian.
  if (frame.toLonLat(-extent, 0)[0] > frame.toLonLat(extent, 0)[0]) {
    return "the planning region crosses the 180° meridian, which the planning API does not take";
  }
  if (
    Math.abs(frame.toLonLat(0, extent)[1]) >= 90 ||
    Math.abs(frame.toLonLat(0, -extent)[1]) >= 90
  ) {
    return "the planning region reaches a pole";
  }
  return { frame, x0: -extent, y0: -extent, unit, side, maxLeaf };
}
