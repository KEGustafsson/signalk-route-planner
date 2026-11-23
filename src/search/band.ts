import type { LonLat } from "../foundation/geo";
import type { Frame } from "../foundation/geo";
import { frameAt, haversine } from "../foundation/geo";
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

/** Node ids: "r<k>" the route's k-th sample, "g<i>,<j>" a grid point. */
class Band {
  readonly samples: XY[] = [];
  private readonly r: XY[];
  private readonly near = new Map<string, boolean>();
  private readonly bySquare = new Map<string, number[]>();
  private readonly legs = new Map<string, boolean>();

  constructor(
    route: readonly LonLat[],
    private readonly frame: Frame,
    private readonly ok: (a: LonLat, b: LonLat) => boolean,
    private readonly shape: { step: number; width: number }
  ) {
    const { step } = shape;
    this.r = route.map((p) => frame.toXY(p));
    this.r.slice(1).forEach((b, i) => {
      const a = this.r[i] as XY;
      const n = Math.max(1, Math.ceil(dist(a, b) / step));
      for (let t = 0; t < n; t++) {
        this.samples.push([a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n]);
      }
    });
    this.samples.push(this.r[this.r.length - 1] as XY);
    this.samples.forEach((p, k) => {
      const key = `${Math.round(p[0] / step)},${Math.round(p[1] / step)}`;
      this.bySquare.set(key, [...(this.bySquare.get(key) ?? []), k]);
    });
  }

  pos(id: string): XY {
    if (id.startsWith("r")) {
      return this.samples[Number(id.slice(1))] as XY;
    }
    const [i, j] = id.slice(1).split(",").map(Number) as [number, number];
    return [i * this.shape.step, j * this.shape.step];
  }

  /** Whether the leg u–v passes: consecutive route samples, parts of a passing leg, unchecked. */
  leg(u: string, v: string): boolean {
    if (u.startsWith("r") && v.startsWith("r")) {
      if (Math.abs(Number(u.slice(1)) - Number(v.slice(1))) === 1) {
        return true;
      }
    }
    const key = u < v ? `${u}|${v}` : `${v}|${u}`;
    let ok = this.legs.get(key);
    if (ok === undefined) {
      const a = this.pos(u);
      const b = this.pos(v);
      ok = this.ok(this.frame.toLonLat(a[0], a[1]), this.frame.toLonLat(b[0], b[1]));
      this.legs.set(key, ok);
    }
    return ok;
  }

  neighbours(id: string): string[] {
    const p = this.pos(id);
    const ci = Math.round(p[0] / this.shape.step);
    const cj = Math.round(p[1] / this.shape.step);
    if (id.startsWith("r")) {
      const k = Number(id.slice(1));
      const along = [`r${k - 1}`, `r${k + 1}`].filter((_, n) =>
        n === 0 ? k > 0 : k < this.samples.length - 1
      );
      return [...along, ...this.grid(ci, cj, KING)];
    }
    return [...this.grid(ci, cj, DIRS), ...this.routeNear(ci, cj, p)];
  }

  private grid(ci: number, cj: number, dirs: readonly [number, number][]): string[] {
    return dirs
      .filter(([di, dj]) => this.inBand(ci + di, cj + dj))
      .map(([di, dj]) => `g${ci + di},${cj + dj}`);
  }

  /** The route samples within 1.5 steps of the grid point p. */
  private routeNear(ci: number, cj: number, p: XY): string[] {
    return [[0, 0] as [number, number], ...KING]
      .flatMap(([di, dj]) => this.bySquare.get(`${ci + di},${cj + dj}`) ?? [])
      .filter((k) => dist(this.samples[k] as XY, p) <= 1.5 * this.shape.step)
      .map((k) => `r${k}`);
  }

  private inBand(i: number, j: number): boolean {
    const key = `${i},${j}`;
    let v = this.near.get(key);
    if (v === undefined) {
      const p: XY = [i * this.shape.step, j * this.shape.step];
      v = this.r.slice(1).some((b, k) => toSegment(p, this.r[k] as XY, b) <= this.shape.width);
      this.near.set(key, v);
    }
    return v;
  }
}

/** The eight grid points around one. */
const KING = DIRS.slice(0, 8);

/**
 * Lazy Theta*: the node ids from "r0" to `goal`; "work" when the work ran out, undefined when none
 * joins. A point reached is given its neighbour's parent, unchecked, and the leg from that parent
 * is checked only when the point is taken from the heap: where it fails, the point joins the
 * nearest-to-start point around it whose leg to it passes. A leg is checked once a point taken.
 */
async function thetaStar(band: Band, limits: PullLimits): Promise<string[] | "work" | undefined> {
  const goal = `r${band.samples.length - 1}`;
  const end = band.pos(goal);
  const g = new Map<string, number>([["r0", 0]]);
  const back = new Map<string, string>();
  const done = new Set<string>();
  const heap = new Heap<string>();
  heap.push("r0", dist(band.pos("r0"), end));
  const via = (from: string, v: string): number =>
    (g.get(from) ?? Infinity) + dist(band.pos(from), band.pos(v));
  // The point's parent, its leg checked: else the best taken neighbour whose leg passes.
  const settle = (u: string): boolean => {
    const p = back.get(u);
    if (p === undefined || band.leg(p, u)) {
      return true;
    }
    const best = band
      .neighbours(u)
      .filter((n) => done.has(n))
      .sort((m, n) => via(m, u) - via(n, u))
      .find((n) => band.leg(n, u));
    if (best === undefined) {
      return false;
    }
    g.set(u, via(best, u));
    back.set(u, best);
    return true;
  };
  while (heap.size > 0 && !done.has(goal)) {
    if (limits.exhausted()) {
      return "work";
    }
    const u = heap.pop();
    if (done.has(u)) {
      continue;
    }
    if (!settle(u)) {
      // No leg to it passes yet: it waits for a neighbour taken later to reach it.
      g.delete(u);
      back.delete(u);
      continue;
    }
    done.add(u);
    // Straight on from u's parent, to be checked when the neighbour is taken.
    const from = back.get(u) ?? u;
    for (const v of band.neighbours(u)) {
      const gv = via(from, v);
      if (!done.has(v) && gv < (g.get(v) ?? Infinity)) {
        g.set(v, gv);
        back.set(v, from);
        heap.push(v, gv + dist(band.pos(v), end));
      }
    }
    if (done.size % 256 === 0) {
      await limits.pause();
    }
  }
  return done.has(goal) ? pathTo(back, goal) : undefined;
}

/** The ids from the start to `goal`, by their parents. */
function pathTo(back: Map<string, string>, goal: string): string[] {
  const path = [goal];
  for (let id = back.get(goal); id !== undefined; id = back.get(id)) {
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
      const cut: LonLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
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

/** Fine band refinement: grid step, band half-width and reach along the route round a turn, metres. */
export const FINE_BAND = { step: 30, width: 200, reach: 500 };

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
  shape: { step: number; width: number; reach: number } = FINE_BAND
): Promise<LonLat[] | undefined> {
  const ok = (a: LonLat, b: LonLat): boolean => passes(check(a, b), rule);
  const out: LonLat[] = [route[0] as LonLat];
  for (const { piece, turn } of aroundTurns(route, shape.reach)) {
    const r = turn ? await refinePiece(piece, ok, limits, shape) : piece;
    if (r === "work") {
      return undefined;
    }
    out.push(...r.slice(1));
  }
  return out;
}
