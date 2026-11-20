import type { LonLat } from "../foundation/geo";
import type { QuadNode, QuadTree } from "./quadtree";

/**
 * Preference lines (plan §4.4, R4c): leading lines, recommended tracks, fairway navigation lines
 * and the boat's own tracks. Water within `reach` of one costs what it would anyway; any other
 * water costs `weight` more per metre, so the route keeps to the lines where the detour is small.
 * Every weight stays at least 1 per metre, as A*'s heuristic needs. A two-way line is moved to
 * the starboard side of the way the boat goes (COLREG rule 9) before it is used.
 */

type XY = [number, number];

export interface PreferredLine {
  coordinates: LonLat[];
  /** Traffic both ways along it: kept to starboard of it by `starboard`. */
  twoWay?: boolean;
}

export interface Preferred {
  /** Lines in the tree's unit coordinates. */
  readonly lines: readonly XY[][];
  /** How near a line water counts as on it, units. */
  readonly reach: number;
  /** Cost per metre added off the lines. */
  readonly weight: number;
  /** Squares larger than this, units, that only partly lie near a line are split. */
  readonly cell: number;
}

function segmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** `line` moved `d` units to the right of the way `travel` points along each of its segments. */
function toStarboard(line: XY[], d: number, travel: XY): XY[] {
  const out: XY[] = [];
  line.slice(1).forEach((b, i) => {
    const a = line[i] as XY;
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      return;
    }
    // Along the boat's way: a segment pointing back is sailed the other way.
    const sign = dx * travel[0] + dy * travel[1] < 0 ? -1 : 1;
    dx = (dx / len) * sign;
    dy = (dy / len) * sign;
    const off: XY = [dy * d, -dx * d];
    out.push([a[0] + off[0], a[1] + off[1]], [b[0] + off[0], b[1] + off[1]]);
  });
  return out;
}

/** The lines in `tree`'s units, the two-way ones moved to starboard for a trip from → to. */
export function preferredIn(
  tree: QuadTree,
  lines: readonly PreferredLine[],
  trip: [LonLat, LonLat],
  how: { reachMetres: number; weight: number; starboardMetres: number; cellMetres: number }
): Preferred | undefined {
  const unit = tree.shape.unit;
  const [fx, fy] = tree.units(trip[0]);
  const [tx, ty] = tree.units(trip[1]);
  const travel: XY = [tx - fx, ty - fy];
  const out = lines
    .filter((l) => l.coordinates.length >= 2)
    .map((l) => {
      const xy = l.coordinates.map((p) => tree.units(p));
      return l.twoWay ? toStarboard(xy, how.starboardMetres / unit, travel) : xy;
    })
    .filter((l) => l.length >= 2);
  if (out.length === 0 || how.weight <= 0) {
    return undefined;
  }
  return {
    lines: out,
    reach: how.reachMetres / unit,
    weight: how.weight,
    cell: how.cellMetres / unit
  };
}

/** Distance from `p`, units, to the nearest preferred line. */
export function lineDistance(pref: Preferred, p: XY): number {
  let best = Infinity;
  for (const line of pref.lines) {
    for (let i = 1; i < line.length; i++) {
      best = Math.min(best, segmentDistance(p, line[i - 1] as XY, line[i] as XY));
    }
  }
  return best;
}

function corners(n: Pick<QuadNode, "x" | "y" | "size">): XY[] {
  return [
    [n.x, n.y],
    [n.x + n.size, n.y],
    [n.x, n.y + n.size],
    [n.x + n.size, n.y + n.size]
  ];
}

/** Whether a segment of a line comes within `reach` of the square. */
function touches(pref: Preferred, n: Pick<QuadNode, "x" | "y" | "size">): boolean {
  const c: XY = [n.x + n.size / 2, n.y + n.size / 2];
  // Within the square's half-diagonal of its centre, plus reach, a line can touch it.
  return lineDistance(pref, c) <= pref.reach + (n.size * Math.SQRT2) / 2;
}

/**
 * Whether the whole square lies within reach of one segment: distance to a segment is convex,
 * so its corners decide.
 */
function within(pref: Preferred, n: Pick<QuadNode, "x" | "y" | "size">): boolean {
  const cs = corners(n);
  return pref.lines.some((line) =>
    line
      .slice(1)
      .some((b, i) => cs.every((p) => segmentDistance(p, line[i] as XY, b) <= pref.reach))
  );
}

/** True when a free square only partly near a line should be split to find the part that is. */
export function splitsForLines(pref: Preferred, n: Pick<QuadNode, "x" | "y" | "size">): boolean {
  return n.size > pref.cell && touches(pref, n) && !within(pref, n);
}

/**
 * The cost per metre a leaf adds off the lines: 0 where its centre, which the search's path runs
 * through, is within reach of one.
 */
export function offLine(pref: Preferred, n: QuadNode): number {
  const c: XY = [n.x + n.size / 2, n.y + n.size / 2];
  return lineDistance(pref, c) <= pref.reach ? 0 : pref.weight;
}

/** The share of the segment a–b, unit coordinates, off the lines, sampled every half reach. */
export function offShare(pref: Preferred, a: XY, b: XY): number {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(len / Math.max(pref.reach / 2, 1e-9)));
  let off = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (lineDistance(pref, p) > pref.reach) {
      off++;
    }
  }
  return off / (n + 1);
}
