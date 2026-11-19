import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, haversine } from "../foundation/geo";
import type { Bbox, Survey } from "../oracle/contract";

/**
 * A corridor for a trip too long for any planning box (plan §4.2): a coarse route on
 * signalk-underkeel's depth survey, over cells whose deepest charted depth takes the draft,
 * grown to a band on each side and cut into boxes for `prepare`. The survey is optimistic, so
 * the coarse route only says where to look; the search and the route check on the corridor's
 * index decide the route.
 */

/** The survey's cell side asked for, metres. */
export const SURVEY_CELL = 100;
/** The survey reaches past the trip's box by a quarter of the trip, within these, metres. */
export const SURVEY_MIN_REACH = 3000;
export const SURVEY_MAX_REACH = 15_000;
/** The corridor reaches this far each side of the coarse route, metres. */
export const CORRIDOR_HALF = 1500;
/** Around each end it reaches this far, for the harbour stage, metres. */
export const END_REACH = 3500;
/** The corridor's boxes are cut from bands this tall, metres. */
const BAND = 1000;
/** An end is joined to the nearest cell that takes the draft within this, metres. */
const SNAP = 1500;
/** signalk-underkeel takes at most this many boxes. */
const MAX_PARTS = 400;

const M_PER_DEG = (EARTH_RADIUS * Math.PI) / 180;

/** The survey's region for the trip `from`–`to`: their box grown by a quarter of the trip. */
export function surveyRegion(from: LonLat, to: LonLat): Bbox {
  const reach = Math.min(SURVEY_MAX_REACH, Math.max(SURVEY_MIN_REACH, haversine(from, to) / 4));
  const s = Math.max(-85, Math.min(from[1], to[1]) - reach / M_PER_DEG);
  const n = Math.min(85, Math.max(from[1], to[1]) + reach / M_PER_DEG);
  const dLon = reach / (M_PER_DEG * Math.cos(Math.max(Math.abs(s), Math.abs(n)) * (Math.PI / 180)));
  return [Math.min(from[0], to[0]) - dLon, s, Math.max(from[0], to[0]) + dLon, n];
}

/** The cell size in degrees: north–south, east–west. */
function cellDegrees(g: Survey): [number, number] {
  const mid = ((g.bbox[1] + g.bbox[3]) / 2) * (Math.PI / 180);
  return [g.cellMetres / M_PER_DEG, g.cellMetres / (M_PER_DEG * Math.cos(mid))];
}

/** The cell `[lon, lat]` lies in, as [column, row], possibly off the grid. */
function cellOf(g: Survey, p: LonLat): [number, number] {
  const [dLat, dLon] = cellDegrees(g);
  return [Math.floor((p[0] - g.bbox[0]) / dLon), Math.floor((p[1] - g.bbox[1]) / dLat)];
}

/** The cell nearest `p` that takes `draft`, within `snap` cells, or -1. */
function nearestWet(g: Survey, p: LonLat, draft: number, snap: number): number {
  const [c0, r0] = cellOf(g, p);
  let best = -1;
  let bestD = Infinity;
  for (let r = Math.max(0, r0 - snap); r <= Math.min(g.rows - 1, r0 + snap); r++) {
    for (let c = Math.max(0, c0 - snap); c <= Math.min(g.cols - 1, c0 + snap); c++) {
      const d = (c - c0) ** 2 + (r - r0) ** 2;
      if (d < bestD && (g.depth[r * g.cols + c] as number) >= draft) {
        best = r * g.cols + c;
        bestD = d;
      }
    }
  }
  return best;
}

/** A binary heap of cell indexes by key. */
class Heap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, key: number): void {
    let i = this.items.length;
    this.items.push(item);
    this.keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.keys[p] as number) <= key) {
        break;
      }
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.items[0] as number;
    const lastItem = this.items.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && (this.keys[l] as number) < (this.keys[m] as number)) {
          m = l;
        }
        if (r < this.items.length && (this.keys[r] as number) < (this.keys[m] as number)) {
          m = r;
        }
        if (m === i) {
          break;
        }
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b] as number, this.items[a] as number];
    [this.keys[a], this.keys[b]] = [this.keys[b] as number, this.keys[a] as number];
  }
}

const STEPS: readonly [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2]
];

/**
 * The shortest 8-connected path of cells taking `draft` from the cell nearest `from` to the one
 * nearest `to`, as cell indexes; undefined when the survey joins them by none.
 */
export function coarseRoute(
  g: Survey,
  from: LonLat,
  to: LonLat,
  draft: number
): number[] | undefined {
  const snap = Math.ceil(SNAP / g.cellMetres);
  const [start, goal] = [from, to].map((p) => nearestWet(g, p, draft, snap)) as [number, number];
  if (start < 0 || goal < 0) {
    return undefined;
  }
  const h = octile(g, goal);
  const cost = new Float64Array(g.cols * g.rows).fill(Infinity);
  const came = new Int32Array(g.cols * g.rows).fill(-1);
  const done = new Uint8Array(g.cols * g.rows);
  const heap = new Heap();
  cost[start] = 0;
  heap.push(start, h(start));
  while (heap.size > 0) {
    const i = heap.pop();
    if (i === goal) {
      return pathTo(came, i);
    }
    if (done[i]) {
      continue;
    }
    done[i] = 1;
    const [c, r] = [i % g.cols, Math.floor(i / g.cols)];
    for (const [dc, dr, step] of STEPS) {
      const [nc, nr] = [c + dc, r + dr];
      const j = nr * g.cols + nc;
      const next = (cost[i] as number) + step;
      const inGrid = nc >= 0 && nr >= 0 && nc < g.cols && nr < g.rows;
      if (inGrid && (g.depth[j] as number) >= draft && next < (cost[j] as number)) {
        cost[j] = next;
        came[j] = i;
        heap.push(j, next + h(j));
      }
    }
  }
  return undefined;
}

/** The octile distance to `goal`, in cells: A*'s heuristic on the 8-connected grid. */
function octile(g: Survey, goal: number): (i: number) => number {
  const gc = goal % g.cols;
  const gr = Math.floor(goal / g.cols);
  return (i) => {
    const dx = Math.abs((i % g.cols) - gc);
    const dy = Math.abs(Math.floor(i / g.cols) - gr);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
}

/** The cells from the start to `i`, by `came`. */
function pathTo(came: Int32Array, i: number): number[] {
  const path = [i];
  for (let p = came[i] as number; p >= 0; p = came[p] as number) {
    path.push(p);
  }
  return path.reverse();
}

/**
 * The corridor around the coarse route `path`: CORRIDOR_HALF each side of it and END_REACH
 * around `from` and `to`, cut into boxes of BAND-tall bands, each band's runs of cells one box.
 */
export function corridorParts(
  g: Survey,
  path: readonly number[],
  from: LonLat,
  to: LonLat
): Bbox[] {
  const mask = new Uint8Array(g.cols * g.rows);
  const fill = (c: number, r: number, k: number): void => {
    for (let y = Math.max(0, r - k); y <= Math.min(g.rows - 1, r + k); y++) {
      mask.fill(1, y * g.cols + Math.max(0, c - k), y * g.cols + Math.min(g.cols - 1, c + k) + 1);
    }
  };
  const half = Math.ceil(CORRIDOR_HALF / g.cellMetres);
  for (const i of path) {
    fill(i % g.cols, Math.floor(i / g.cols), half);
  }
  const end = Math.ceil(END_REACH / g.cellMetres);
  for (const p of [from, to]) {
    const [c, r] = cellOf(g, p);
    fill(Math.min(g.cols - 1, Math.max(0, c)), Math.min(g.rows - 1, Math.max(0, r)), end);
  }
  let band = Math.max(1, Math.round(BAND / g.cellMetres));
  for (;;) {
    const parts = bands(g, mask, band);
    if (parts.length <= MAX_PARTS) {
      return parts;
    }
    band *= 2;
  }
}

/** The runs of marked cells in each band of `band` rows, as boxes. */
function bands(g: Survey, mask: Uint8Array, band: number): Bbox[] {
  const [dLat, dLon] = cellDegrees(g);
  const [w, s] = g.bbox;
  const parts: Bbox[] = [];
  const used = new Uint8Array(g.cols);
  for (let r0 = 0; r0 < g.rows; r0 += band) {
    const r1 = Math.min(g.rows, r0 + band);
    used.fill(0);
    for (let r = r0; r < r1; r++) {
      for (let c = 0; c < g.cols; c++) {
        used[c] = (used[c] as number) | (mask[r * g.cols + c] as number);
      }
    }
    for (let c = 0; c < g.cols;) {
      if (!used[c]) {
        c++;
        continue;
      }
      const c0 = c;
      while (c < g.cols && used[c]) {
        c++;
      }
      parts.push([w + c0 * dLon, s + r0 * dLat, w + c * dLon, s + r1 * dLat]);
    }
  }
  return parts;
}

/** The box of `parts`. */
export function boxOf(parts: readonly Bbox[]): Bbox {
  return parts.reduce((a, b) => [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3])
  ]);
}

/** The corridor for the trip `from`–`to` on the survey `g`, or undefined when it joins them by none. */
export function corridorFor(
  g: Survey,
  from: LonLat,
  to: LonLat,
  draft: number
): Bbox[] | undefined {
  const path = coarseRoute(g, from, to, draft);
  return path && corridorParts(g, path, from, to);
}
