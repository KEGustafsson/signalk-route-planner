import type { LonLat } from "../foundation/geo";
import type { Frame } from "../foundation/geo";
import { frameAt, haversine, wrapLon } from "../foundation/geo";
import type { Verdict } from "../oracle/contract";
import { Heap } from "./heap";
import type { PassRule } from "./passes";
import { passes } from "./passes";
import type { PullLimits } from "./pull";

/**
 * Band refinement (plan §4.1 step 16). Pulling and the taut string shorten a route only within
 * its way round each island: a route the search led north of an islet stays north of it, however
 * much shorter the way south. Here an any-angle search (Theta*) runs on a fine grid of points in
 * a band along the route, with the route's own points every grid step as nodes too, each leg it
 * takes checked as it reaches it: the grid finds the shorter way round, and the route's own points
 * carry it through water narrower than the grid, a harbour mouth or a fairway's gap. Its answer
 * is the shortest way through the band the grid resolves; the caller keeps it only when it is
 * shorter than the route it had.
 */

/** Grid step, metres. */
export const BAND_STEP = 100;
/** How far from the route the grid reaches, metres. */
export const BAND_WIDTH = 1000;
/** Route searched at a time, metres. */
export const BAND_WINDOW = 8000;

/** Grid neighbours: the 16 directions of a knight's move and a king's. */
const DIRS: readonly [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [2, 1],
  [1, 2],
  [-2, 1],
  [-1, 2],
  [2, -1],
  [1, -2],
  [-2, -1],
  [-1, -2]
];

type XY = [number, number];

const dist = (a: XY, b: XY): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Distance from p to the segment a–b. */
function toSegment(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * The band's nodes by number: the route's k-th sample is node k, and after them the points of
 * the grid's rectangle around the route, row by row; `inBand` says which of those lie in the band.
 */
class Band {
  readonly samples: XY[] = [];
  private readonly r: XY[];
  /** Per grid node: 1 in the band, 0 not, -1 not yet told. */
  private readonly near: Int8Array;
  private readonly bySquare = new Map<number, number[]>();
  private readonly legs = new Map<number, boolean>();
  /** The grid rectangle: its first column and row, and its columns and rows. */
  private readonly i0: number;
  private readonly j0: number;
  private readonly cols: number;
  private readonly rows: number;
  /** Nodes in all. */
  readonly size: number;

  constructor(
    route: readonly LonLat[],
    private readonly frame: Frame,
    private readonly ok: (a: LonLat, b: LonLat) => boolean,
    private readonly shape: { step: number; width: number }
  ) {
    const { step, width } = shape;
    this.r = route.map((p) => frame.toXY(p));
    this.r.slice(1).forEach((b, i) => {
      const a = this.r[i] as XY;
      const n = Math.max(1, Math.ceil(dist(a, b) / step));
      for (let t = 0; t < n; t++) {
        this.samples.push([a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n]);
      }
    });
    this.samples.push(this.r[this.r.length - 1] as XY);
    // Every point within the band's width of the route, and the squares round its samples.
    const reach = Math.ceil(width / step) + 2;
    const is = this.r.map((p) => Math.round(p[0] / step));
    const js = this.r.map((p) => Math.round(p[1] / step));
    this.i0 = Math.min(...is) - reach;
    this.j0 = Math.min(...js) - reach;
    this.cols = Math.max(...is) + reach - this.i0 + 1;
    this.rows = Math.max(...js) + reach - this.j0 + 1;
    this.near = new Int8Array(this.cols * this.rows).fill(-1);
    this.size = this.samples.length + this.cols * this.rows;
    this.samples.forEach((p, k) => {
      const key = this.square(Math.round(p[0] / step), Math.round(p[1] / step));
      const at = this.bySquare.get(key);
      if (at) {
        at.push(k);
      } else {
        this.bySquare.set(key, [k]);
      }
    });
  }

  /** The grid square (i, j) as a number: its place in the rectangle, or -1 outside it. */
  private square(i: number, j: number): number {
    const c = i - this.i0;
    const r = j - this.j0;
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows ? r * this.cols + c : -1;
  }

  private isRoute(id: number): boolean {
    return id < this.samples.length;
  }

  pos(id: number): XY {
    if (this.isRoute(id)) {
      return this.samples[id] as XY;
    }
    const at = id - this.samples.length;
    return [
      ((at % this.cols) + this.i0) * this.shape.step,
      (Math.floor(at / this.cols) + this.j0) * this.shape.step
    ];
  }

  /** Whether the leg u–v passes: consecutive route samples, parts of a passing leg, unchecked. */
  leg(u: number, v: number): boolean {
    if (this.isRoute(u) && this.isRoute(v) && Math.abs(u - v) === 1) {
      return true;
    }
    const key = u < v ? u * this.size + v : v * this.size + u;
    let ok = this.legs.get(key);
    if (ok === undefined) {
      const a = this.pos(u);
      const b = this.pos(v);
      ok = this.ok(this.frame.toLonLat(a[0], a[1]), this.frame.toLonLat(b[0], b[1]));
      this.legs.set(key, ok);
    }
    return ok;
  }

  neighbours(id: number): number[] {
    const p = this.pos(id);
    const ci = Math.round(p[0] / this.shape.step);
    const cj = Math.round(p[1] / this.shape.step);
    if (this.isRoute(id)) {
      const along: number[] = [];
      if (id > 0) {
        along.push(id - 1);
      }
      if (id < this.samples.length - 1) {
        along.push(id + 1);
      }
      return [...along, ...this.grid(ci, cj, KING)];
    }
    return [...this.grid(ci, cj, DIRS), ...this.routeNear(ci, cj, p)];
  }

  private grid(ci: number, cj: number, dirs: readonly [number, number][]): number[] {
    const out: number[] = [];
    for (const [di, dj] of dirs) {
      if (this.inBand(ci + di, cj + dj)) {
        out.push(this.samples.length + this.square(ci + di, cj + dj));
      }
    }
    return out;
  }

  /** The route samples within 1.5 steps of the grid point p. */
  private routeNear(ci: number, cj: number, p: XY): number[] {
    const out: number[] = [];
    for (const [di, dj] of AROUND) {
      for (const k of this.bySquare.get(this.square(ci + di, cj + dj)) ?? []) {
        if (dist(this.samples[k] as XY, p) <= 1.5 * this.shape.step) {
          out.push(k);
        }
      }
    }
    return out;
  }

  private inBand(i: number, j: number): boolean {
    const at = this.square(i, j);
    if (at < 0) {
      return false;
    }
    let v = this.near[at] as number;
    if (v < 0) {
      const p: XY = [i * this.shape.step, j * this.shape.step];
      const r = this.r;
      v = 0;
      for (let k = 1; k < r.length && v === 0; k++) {
        v = toSegment(p, r[k - 1] as XY, r[k] as XY) <= this.shape.width ? 1 : 0;
      }
      this.near[at] = v;
    }
    return v === 1;
  }
}

/** The eight grid points around one. */
const KING = DIRS.slice(0, 8);

/** A grid point's own square and the eight around it. */
const AROUND: readonly [number, number][] = [[0, 0], ...KING];

/**
 * Lazy Theta*: the nodes from the route's first sample to its last; "work" when the work ran
 * out, undefined when none joins. A point reached is given its neighbour's parent, unchecked, and
 * the leg from that parent is checked only when the point is taken from the heap: where it fails,
 * the point joins the nearest-to-start point around it whose leg to it passes. A leg is checked
 * once a point taken.
 */
async function thetaStar(band: Band, limits: PullLimits): Promise<number[] | "work" | undefined> {
  const goal = band.samples.length - 1;
  const end = band.pos(goal);
  const { g, back, done, heap } = begun(band, end);
  let taken = 0;
  const via = (from: number, v: number): number =>
    (g[from] as number) + dist(band.pos(from), band.pos(v));
  const settle = settler(band, { g, back, done }, via);
  const reach = (v: number, from: number, gv: number): void => {
    g[v] = gv;
    back[v] = from;
    heap.push(v, gv + dist(band.pos(v), end));
  };
  while (heap.size > 0 && done[goal] !== 1) {
    if (limits.exhausted()) {
      return "work";
    }
    const u = heap.pop();
    if (done[u] === 1) {
      continue;
    }
    if (!settle(u)) {
      // No leg to it passes yet: it waits for a neighbour taken later to reach it.
      g[u] = Infinity;
      back[u] = -1;
      continue;
    }
    done[u] = 1;
    taken++;
    // Straight on from u's parent, to be checked when the neighbour is taken.
    const from = (back[u] as number) < 0 ? u : (back[u] as number);
    for (const v of band.neighbours(u)) {
      const gv = via(from, v);
      if (done[v] !== 1 && gv < (g[v] as number)) {
        reach(v, from, gv);
      }
    }
    if (taken % 256 === 0) {
      await limits.pause();
    }
  }
  return done[goal] === 1 ? pathTo(back, goal) : undefined;
}

/** A search's state with the route's first sample queued: costs, parents, the points taken. */
function begun(band: Band, end: XY) {
  const g = new Float64Array(band.size).fill(Infinity);
  const heap = new Heap<number>();
  g[0] = 0;
  heap.push(0, dist(band.pos(0), end));
  return { g, back: new Int32Array(band.size).fill(-1), done: new Uint8Array(band.size), heap };
}

/**
 * Settles a point taken from the heap: true with its parent's leg to it checked and passing,
 * else with the best taken neighbour whose leg passes as its parent; false when none does.
 */
function settler(
  band: Band,
  s: { g: Float64Array; back: Int32Array; done: Uint8Array },
  via: (from: number, v: number) => number
): (u: number) => boolean {
  return (u) => {
    const p = s.back[u] as number;
    if (p < 0 || band.leg(p, u)) {
      return true;
    }
    const best = band
      .neighbours(u)
      .filter((n) => s.done[n] === 1)
      .sort((m, n) => via(m, u) - via(n, u))
      .find((n) => band.leg(n, u));
    if (best === undefined) {
      return false;
    }
    s.g[u] = via(best, u);
    s.back[u] = best;
    return true;
  };
}

/** The nodes from the start to `goal`, by their parents. */
function pathTo(back: Int32Array, goal: number): number[] {
  const path = [goal];
  for (let id = back[goal] as number; id >= 0; id = back[id] as number) {
    path.push(id);
  }
  return path.reverse();
}

/** The route cut where it is `cuts` metres along (ascending), each piece its own route. */
function cutAt(route: readonly LonLat[], cuts: readonly number[]): LonLat[][] {
  const out: LonLat[][] = [];
  let piece: LonLat[] = [route[0] as LonLat];
  let at = 0;
  let c = 0;
  route.slice(1).forEach((b, k) => {
    const a = route[k] as LonLat;
    const len = haversine(a, b);
    for (; c < cuts.length && len > 0 && at + len > (cuts[c] as number); c++) {
      const t = ((cuts[c] as number) - at) / len;
      const cut: LonLat = [wrapLon(a[0] + wrapLon(b[0] - a[0]) * t), a[1] + (b[1] - a[1]) * t];
      piece.push(cut);
      out.push(piece);
      piece = [cut];
    }
    piece.push(b);
    at += len;
  });
  out.push(piece);
  return out.filter((q) => q.length > 1);
}

/** Metres along the route to each of its points. */
function along(route: readonly LonLat[]): number[] {
  const out = [0];
  route.slice(1).forEach((b, k) => out.push((out[k] as number) + haversine(route[k] as LonLat, b)));
  return out;
}

/** The route cut at every `window` metres along it from `offset`, each piece its own route. */
export function pieces(route: readonly LonLat[], window: number, offset: number): LonLat[][] {
  const total = along(route).at(-1) ?? 0;
  const cuts: number[] = [];
  for (let d = offset > 0 ? offset : window; d < total; d += window) {
    cuts.push(d);
  }
  return cutAt(route, cuts);
}

/**
 * The route cut into stretches within `reach` metres along it of a turn, joined where they meet,
 * and the straight legs between: each piece with whether it lies round a turn.
 */
export function aroundTurns(
  route: readonly LonLat[],
  reach: number
): { piece: LonLat[]; turn: boolean }[] {
  const at = along(route);
  const total = at.at(-1) ?? 0;
  const spans: [number, number][] = [];
  for (const d of at.slice(1, -1)) {
    const lo = Math.max(0, d - reach);
    const hi = Math.min(total, d + reach);
    const last = spans.at(-1);
    if (last && lo <= last[1]) {
      last[1] = hi;
    } else {
      spans.push([lo, hi]);
    }
  }
  const cuts = spans.flat().filter((d) => d > 0 && d < total);
  const out = cutAt(route, cuts);
  // Pieces alternate from the start: round a turn first when the first span starts at 0.
  const first = spans[0]?.[0] === 0;
  return out.map((piece, k) => ({ piece, turn: k % 2 === 0 ? first : !first }));
}

/** Theta* over the band along one piece: its route, the piece itself when it is straight. */
async function refinePiece(
  piece: readonly LonLat[],
  ok: (a: LonLat, b: LonLat) => boolean,
  limits: PullLimits,
  shape: { step: number; width: number }
): Promise<LonLat[] | "work"> {
  const first = piece[0] as LonLat;
  const last = piece[piece.length - 1] as LonLat;
  if (piece.length < 3) {
    return [...piece];
  }
  const frame = frameAt(first);
  const band = new Band(piece, frame, ok, shape);
  const path = await thetaStar(band, limits);
  if (path === "work") {
    return path;
  }
  // None joins only if a check differs from the route's: the piece as it was.
  return path === undefined
    ? [...piece]
    : path.map((id, k): LonLat => {
        if (k === 0) {
          return first;
        }
        if (k === path.length - 1) {
          return last;
        }
        const p = band.pos(id);
        return frame.toLonLat(p[0], p[1]);
      });
}

/**
 * The shortest route the band's grid finds from the route's first point to its last, every leg
 * checked and passing `rule`, or the route's own; undefined when the work ran out. `route` must be
 * a route whose legs pass: its points every step are joined to the next unchecked, as parts of a
 * passing leg. The search runs piece by piece, `window` metres of route each, so each explores
 * only round its own piece; a second round, its pieces offset by half a window, takes the ways
 * round that a cut between pieces split.
 */
export async function bandShortest(
  route: readonly LonLat[],
  check: (a: LonLat, b: LonLat) => Verdict,
  limits: PullLimits,
  rule: PassRule,
  shape: { step: number; width: number; window: number } = {
    step: BAND_STEP,
    width: BAND_WIDTH,
    window: BAND_WINDOW
  }
): Promise<LonLat[] | undefined> {
  const ok = (a: LonLat, b: LonLat): boolean => passes(check(a, b), rule);
  let cur: LonLat[] = [...route];
  for (const offset of [0, shape.window / 2]) {
    const next: LonLat[] = [cur[0] as LonLat];
    for (const piece of pieces(cur, shape.window, offset)) {
      const r = await refinePiece(piece, ok, limits, shape);
      if (r === "work") {
        return undefined;
      }
      next.push(...r.slice(1));
    }
    cur = next;
  }
  return cur;
}

/**
 * Fine band refinement: grid step, band half-width, reach along the route round a turn, and the
 * most route searched at a time, metres.
 */
export const FINE_BAND = { step: 30, width: 200, reach: 500, window: BAND_WINDOW };

/**
 * The route searched again on a fine grid only round its turns (`aroundTurns`): a taut route
 * turns only where it touches land or a shoal, so a shorter way round one, through a gap narrower
 * than the first band's grid, starts near a turn; its straight legs between are kept. Undefined
 * when the work ran out.
 */
export async function bandAroundTurns(
  route: readonly LonLat[],
  check: (a: LonLat, b: LonLat) => Verdict,
  limits: PullLimits,
  rule: PassRule,
  shape: { step: number; width: number; reach: number; window?: number } = FINE_BAND
): Promise<LonLat[] | undefined> {
  const ok = (a: LonLat, b: LonLat): boolean => passes(check(a, b), rule);
  const window = shape.window ?? FINE_BAND.window;
  const out: LonLat[] = [route[0] as LonLat];
  for (const { piece, turn } of aroundTurns(route, shape.reach)) {
    // Turns run together over a long stretch are searched a window at a time: a band's grid is
    // made whole before the work limit can stop its search.
    for (const part of turn ? pieces(piece, window, 0) : [piece]) {
      const r = turn ? await refinePiece(part, ok, limits, shape) : part;
      if (r === "work") {
        return undefined;
      }
      out.push(...r.slice(1));
    }
  }
  return out;
}
