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
  /** Their segments, and a grid of the segments near each cell, `GRID` units on a side. */
  readonly segments: readonly [XY, XY][];
  readonly grid: ReadonlyMap<string, readonly number[]>;
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

/**
 * `line` moved `d` units to the right of the way the boat sails it: from the end nearer the
 * trip's start, `travel` pointing along the trip, and on through its bends, so a fairway that
 * winds back on itself keeps the same side.
 */
function toStarboard(line: XY[], d: number, travel: XY): XY[] {
  const first = line[0] as XY;
  const last = line[line.length - 1] as XY;
  const along = (last[0] - first[0]) * travel[0] + (last[1] - first[1]) * travel[1];
  const sailed = along < 0 ? [...line].reverse() : line;
  const out: XY[] = [];
  sailed.slice(1).forEach((b, i) => {
    const a = sailed[i] as XY;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      return;
    }
    const off: XY = [(dy / len) * d, (-dx / len) * d];
    out.push([a[0] + off[0], a[1] + off[1]], [b[0] + off[0], b[1] + off[1]]);
  });
  return out;
}

/** Grid cell side, units: a query visits the cells its reach meets. */
const GRID = 64;

const cellKey = (x: number, y: number): string => `${x},${y}`;

/** The part of the segment a–b inside the box lo–hi (Liang–Barsky), or none. */
function clipped(a: XY, b: XY, lo: number, hi: number): [XY, XY] | undefined {
  let t0 = 0;
  let t1 = 1;
  const d: XY = [b[0] - a[0], b[1] - a[1]];
  for (const axis of [0, 1] as const) {
    for (const [p, q] of [
      [-d[axis], a[axis] - lo],
      [d[axis], hi - a[axis]]
    ] as const) {
      if (p === 0) {
        if (q < 0) {
          return undefined;
        }
        continue;
      }
      const r = q / p;
      if (p < 0) {
        t0 = Math.max(t0, r);
      } else {
        t1 = Math.min(t1, r);
      }
      if (t0 > t1) {
        return undefined;
      }
    }
  }
  const at = (t: number): XY => [a[0] + d[0] * t, a[1] + d[1] * t];
  return [at(t0), at(t1)];
}

/**
 * The segments of `lines` clipped to the tree's square grown by `reach`, and each grid cell's
 * segments. Every part of a line within reach of a point in the square lies in that box, so no
 * distance the search asks changes, and a long line fills only the cells near the region.
 */
function gridOf(
  lines: readonly XY[][],
  side: number,
  reach: number
): Pick<Preferred, "segments" | "grid"> {
  const segments: [XY, XY][] = lines.flatMap((l) =>
    l
      .slice(1)
      .map((b, i) => clipped(l[i] as XY, b, -reach, side + reach))
      .filter((s): s is [XY, XY] => s !== undefined)
  );
  const grid = new Map<string, number[]>();
  segments.forEach(([a, b], k) => {
    const x0 = Math.floor(Math.min(a[0], b[0]) / GRID);
    const x1 = Math.floor(Math.max(a[0], b[0]) / GRID);
    const y0 = Math.floor(Math.min(a[1], b[1]) / GRID);
    const y1 = Math.floor(Math.max(a[1], b[1]) / GRID);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const at = grid.get(cellKey(x, y));
        if (at) {
          at.push(k);
        } else {
          grid.set(cellKey(x, y), [k]);
        }
      }
    }
  });
  return { segments, grid };
}

/** The segments with a part within `r` units of `p`, each once. */
function segmentsNear(pref: Preferred, p: XY, r: number): [XY, XY][] {
  const seen = new Set<number>();
  const x0 = Math.floor((p[0] - r) / GRID);
  const x1 = Math.floor((p[0] + r) / GRID);
  const y0 = Math.floor((p[1] - r) / GRID);
  const y1 = Math.floor((p[1] + r) / GRID);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (const k of pref.grid.get(cellKey(x, y)) ?? []) {
        seen.add(k);
      }
    }
  }
  return [...seen].map((k) => pref.segments[k] as [XY, XY]);
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
  const reach = how.reachMetres / unit;
  return {
    lines: out,
    ...gridOf(out, tree.shape.side, reach),
    reach,
    weight: how.weight,
    cell: how.cellMetres / unit
  };
}

/** Distance from `p`, units, to the nearest preferred line within `limit`; Infinity past it. */
export function lineDistance(pref: Preferred, p: XY, limit: number): number {
  let best = Infinity;
  for (const [a, b] of segmentsNear(pref, p, limit)) {
    best = Math.min(best, segmentDistance(p, a, b));
  }
  return best <= limit ? best : Infinity;
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
  const r = pref.reach + (n.size * Math.SQRT2) / 2;
  return lineDistance(pref, c, r) <= r;
}

/**
 * Whether the whole square lies within reach of one segment: distance to a segment is convex,
 * so its corners decide.
 */
function within(pref: Preferred, n: Pick<QuadNode, "x" | "y" | "size">): boolean {
  const cs = corners(n);
  const c: XY = [n.x + n.size / 2, n.y + n.size / 2];
  return segmentsNear(pref, c, pref.reach + (n.size * Math.SQRT2) / 2).some(([a, b]) =>
    cs.every((p) => segmentDistance(p, a, b) <= pref.reach)
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
  return lineDistance(pref, c, pref.reach) <= pref.reach ? 0 : pref.weight;
}

/**
 * The share of the segment a–b, unit coordinates, off the lines, sampled every half reach. A
 * sample in a leaf of `tree` is on a line as the search counts its leaf (`offLine`), so a
 * shortcut is priced as the squares it crosses are; elsewhere, by its own distance to one.
 */
export function offShare(pref: Preferred, a: XY, b: XY, tree?: QuadTree): number {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(len / Math.max(pref.reach / 2, 1e-9)));
  let off = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const leaf = tree?.leafAt(p[0], p[1]);
    const away = leaf ? offLine(pref, leaf) > 0 : lineDistance(pref, p, pref.reach) > pref.reach;
    if (away) {
      off++;
    }
  }
  return off / (n + 1);
}
