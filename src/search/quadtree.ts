import type { Frame, LonLat } from "../foundation/geo";
import { coveredShare, grownBox, grownBoxKm2 } from "../foundation/geo";
import type { Session, Status } from "../oracle/contract";
import { Heap } from "./heap";
import type { PassRule } from "./passes";
import { OK_ONLY, passes } from "./passes";

/**
 * The search region as a quadtree classified lazily through the planning API
 * (plan §4.1 step 2). Coordinates are integer units of `unit` metres from the
 * region's south-west corner, so the squares of one tree tile it exactly.
 *
 * A square whose box verdict passes (`passes.ts`: `ok`, or an accepted
 * `unverified`) is free water: every leg inside it, with
 * the corridor half-width around it, is inside the box the verdict covered.
 * Any other verdict splits the square, down to one unit, and so does a free square whose risk
 * weighs in the route's cost, or only part of which lies near a preference line (`splitFree`);
 * a one-unit square
 * that is `marginal` stays passable at a cost (search/fallback.ts), and any other
 * that does not pass is blocked, remembered as unverified when its verdict said so.
 */

/** The largest box with its buffer the tree sends, km²: under the planning API's 25. */
export const MAX_BOX_KM2 = 24;

/** A one-unit square too large to ask about: never free, counted as unverified. */
const TOO_LARGE = { status: "unverified" as const, risk: 0, flags: ["BOX_TOO_LARGE"] };

/**
 * A square whose box reaches past a corridor's boxes (`Session.within`): the chart reads no
 * coverage there, as the planning API says it, so it is not asked.
 */
const PAST_CORRIDOR = { status: "unverified" as const, risk: 0, flags: ["NO_COVERAGE"] };

/** A square the field settles as passing: free water, with nothing more known of it. */
const SETTLED_FREE = { status: "ok" as const, risk: 0, flags: [] as string[] };

/** Covered shares this close to 1 are whole: the corridor's boxes meet edge to edge. */
const WHOLE = 1 - 1e-9;

export type NodeState = "unknown" | "free" | "marginal" | "blocked" | "unverified" | "split";

export interface QuadNode {
  id: number;
  x: number;
  y: number;
  size: number;
  state: NodeState;
  children?: QuadNode[];
  /** The verdict that classified it; absent for squares split for size alone. */
  verdict?: { status: Status; flags: string[]; risk: number };
}

export interface TreeShape {
  frame: Frame;
  /** South-west corner of the region in the frame, metres. */
  x0: number;
  y0: number;
  /** Metres per unit: the smallest square's side. */
  unit: number;
  /** The region's side in units, a power of two. */
  side: number;
  /** Squares larger than this many units are split without asking the chart. */
  maxLeaf: number;
}

export class QuadTree {
  readonly root: QuadNode;
  private nextId = 0;
  /** Each square's parent, by its id: the root has none. */
  private readonly parents: QuadNode[] = [];
  /** Squares classified so far. */
  classified = 0;
  /** Squares found unverified: one unit on a side, or past a corridor (`Session.within`). */
  unverified = 0;

  constructor(
    readonly shape: TreeShape,
    private readonly session: Session,
    private readonly rule: PassRule = OK_ONLY,
    /**
     * True when a free square should be split all the same: its risk weighs enough in the
     * route's cost (`fallback.ts`, `RiskCost`) to find the clearer water in it, or only part of
     * it lies near a preference line (`prefer.ts`).
     */
    private readonly splitFree: (n: QuadNode, risk: number) => boolean = () => false,
    /**
     * Settles a square without asking the chart, where it can (`field.ts`): true, the box
     * verdict passes the rule; false, it does not. Given only where no more of a square's
     * verdict is read than that: a square it passes has no risk or flags to weigh, and one
     * larger than a unit it fails is split unasked.
     */
    private readonly settle?: { box(sw: LonLat, ne: LonLat): boolean | undefined }
  ) {
    this.root = this.node(0, 0, shape.side);
  }

  private node(x: number, y: number, size: number): QuadNode {
    return { id: this.nextId++, x, y, size, state: "unknown" };
  }

  /** The point at unit coordinates (ux, uy). */
  lonLat(ux: number, uy: number): LonLat {
    const s = this.shape;
    return s.frame.toLonLat(s.x0 + ux * s.unit, s.y0 + uy * s.unit);
  }

  /** `p` in unit coordinates. */
  units(p: LonLat): [number, number] {
    const s = this.shape;
    const [x, y] = s.frame.toXY(p);
    return [(x - s.x0) / s.unit, (y - s.y0) / s.unit];
  }

  private split(n: QuadNode): void {
    const h = n.size / 2;
    n.state = "split";
    n.children = [
      this.node(n.x, n.y, h),
      this.node(n.x + h, n.y, h),
      this.node(n.x, n.y + h, h),
      this.node(n.x + h, n.y + h, h)
    ];
    for (const c of n.children) {
      this.parents[c.id] = n;
    }
  }

  /**
   * Classifies `n` as `verdict` says, unasked: split while it is larger than one unit and
   * `split` holds, else unverified.
   */
  private unasked(n: QuadNode, verdict: typeof TOO_LARGE, split = true): void {
    if (split && n.size > 1) {
      this.split(n);
      return;
    }
    n.verdict = { ...verdict, flags: [...verdict.flags] };
    n.state = "unverified";
    this.unverified++;
  }

  /**
   * Whether `n`, with corners sw–ne, reaches past a corridor's boxes (`Session.within`), and
   * was classified for it: past them the chart reads no coverage, never free, so it is not
   * asked. A square across their edge is split until its parts lie inside or outside them.
   */
  private pastCorridor(n: QuadNode, sw: LonLat, ne: LonLat): boolean {
    const within = this.session.within;
    if (!within) {
      return false;
    }
    const share = coveredShare(grownBox(sw, ne, this.session.halfWidth), within);
    if (share >= WHOLE) {
      return false;
    }
    this.unasked(n, PAST_CORRIDOR, share > 0);
    return true;
  }

  /** Classifies an unknown square: free, blocked, unverified, or split. */
  resolve(n: QuadNode): void {
    if (n.state !== "unknown") {
      return;
    }
    if (n.size > this.shape.maxLeaf) {
      this.split(n);
      return;
    }
    const sw = this.lonLat(n.x, n.y);
    const ne = this.lonLat(n.x + n.size, n.y + n.size);
    // A box's longitude span widens away from the frame's origin latitude.
    if (grownBoxKm2(sw, ne, this.session.halfWidth) > MAX_BOX_KM2) {
      this.unasked(n, TOO_LARGE);
      return;
    }
    if (this.pastCorridor(n, sw, ne)) {
      return;
    }
    const sure = this.settle?.box(sw, ne);
    this.classified++;
    if (sure === false && n.size > 1) {
      this.split(n);
      return;
    }
    const v = sure === true ? SETTLED_FREE : this.session.box(sw, ne);
    n.verdict = { status: v.status, flags: v.flags, risk: v.risk };
    if (passes(v, this.rule) && !(n.size > 1 && this.splitFree(n, v.risk))) {
      n.state = "free";
    } else if (n.size > 1) {
      this.split(n);
    } else if (v.status === "marginal") {
      // Passable at a cost (search/fallback.ts): a strict plan accepts a marginal leg.
      n.state = "marginal";
    } else if (v.status === "unverified") {
      n.state = "unverified";
      this.unverified++;
    } else {
      n.state = "blocked";
    }
  }

  /**
   * The leaves whose squares meet `touches`, classified as needed; a split
   * square is entered only when `touches` holds for it. With `classify` false no
   * chart query is made: a square not yet classified comes back `unknown`, once it
   * is no larger than `maxLeaf` (larger ones split without asking). Once `stop` holds,
   * no further square is classified and the leaves found so far are returned.
   */
  leaves(
    touches: (n: QuadNode) => boolean,
    classify = true,
    stop: () => boolean = () => false,
    from: QuadNode = this.root
  ): QuadNode[] {
    const out: QuadNode[] = [];
    const stack = [from];
    while (stack.length > 0 && !stop()) {
      const n = stack.pop() as QuadNode;
      if (!touches(n)) {
        continue;
      }
      if (classify || n.size > this.shape.maxLeaf) {
        this.resolve(n);
      }
      if (n.state === "split") {
        stack.push(...(n.children as QuadNode[]));
      } else {
        out.push(n);
      }
    }
    return out;
  }

  /**
   * Up to `k` leaves that `accept` takes, nearest the unit point (ux, uy) by the
   * distance to their squares, within `radius` units. Best first: a square is
   * classified only when nothing nearer is left, so the query costs the squares
   * nearer than the k-th leaf it returns, not the whole disc. It stops once `stop` holds.
   * With `via`, a second unit point, they come in order of the way from (ux, uy) through
   * the square on to `via` instead: still only squares within `radius` of (ux, uy).
   */
  nearest(
    ux: number,
    uy: number,
    radius: number,
    accept: (n: QuadNode) => boolean,
    k: number,
    stop: () => boolean = () => false,
    via?: [number, number]
  ): QuadNode[] {
    const to = (n: QuadNode, px: number, py: number): number =>
      Math.hypot(
        Math.max(n.x - px, 0, px - (n.x + n.size)),
        Math.max(n.y - py, 0, py - (n.y + n.size))
      );
    // A lower bound for every point of the square, so the order holds as squares split.
    const key = (n: QuadNode): number => to(n, ux, uy) + (via ? to(n, via[0], via[1]) : 0);
    const open = new Heap<QuadNode>();
    const push = (n: QuadNode): void => {
      if (to(n, ux, uy) <= radius) {
        open.push(n, key(n));
      }
    };
    push(this.root);
    const out: QuadNode[] = [];
    while (open.size > 0 && out.length < k && !stop()) {
      const n = open.pop();
      this.resolve(n);
      if (n.state === "split") {
        for (const c of n.children as QuadNode[]) {
          push(c);
        }
      } else if (accept(n)) {
        out.push(n);
      }
    }
    return out;
  }

  /** The leaf holding unit point (ux, uy); a point on an edge goes to the square east or north. */
  leafAt(ux: number, uy: number): QuadNode | undefined {
    const side = this.shape.side;
    if (!(ux >= 0 && uy >= 0 && ux <= side && uy <= side)) {
      return undefined;
    }
    const cx = Math.min(ux, side - 1e-9);
    const cy = Math.min(uy, side - 1e-9);
    return this.leaves((n) => cx >= n.x && cx < n.x + n.size && cy >= n.y && cy < n.y + n.size)[0];
  }

  /**
   * The smallest square holding every square that touches `n`'s edge or corners: the first above
   * `n` reaching past each of its edges, or the region's edge. Every square that touches `n` lies
   * in it, as squares either nest or do not meet, so a walk from it finds what one from the root
   * does; its ancestors are split already.
   */
  private around(n: QuadNode): QuadNode {
    const side = this.shape.side;
    const { x, y, size } = n;
    const holds = (a: QuadNode): boolean =>
      (a.x < x || x === 0) &&
      (a.x + a.size > x + size || x + size === side) &&
      (a.y < y || y === 0) &&
      (a.y + a.size > y + size || y + size === side);
    let a = n;
    for (let p = this.parents[a.id]; p !== undefined; p = this.parents[a.id]) {
      a = p;
      if (holds(a)) {
        break;
      }
    }
    return a;
  }

  /**
   * Free leaves sharing an edge of positive length with `n`, with the shared edge's
   * midpoint, and those meeting it at a corner only, with that corner: east, west, north and
   * south, then the corners north-east, north-west, south-east and south-west, each side's in
   * the tree's order. One walk down the tree finds them all: every square that touches `n`'s
   * edge or corner, the ones a side or a corner is asked about, classified as needed.
   */
  neighbours(
    n: QuadNode,
    enter: (m: QuadNode) => boolean = isFree,
    classify = true
  ): { node: QuadNode; portal: [number, number] }[] {
    const { x, y, size } = n;
    const x1 = x + size;
    const y1 = y + size;
    const ring = this.leaves(
      (m) => m.x <= x1 && x <= m.x + m.size && m.y <= y1 && y <= m.y + m.size,
      classify,
      undefined,
      this.around(n)
    );
    // Unclassified: a candidate the caller classifies when it gets to it.
    const may = (m: QuadNode): boolean =>
      m !== n && ((!classify && m.state === "unknown") || enter(m));
    // East, west, north, south, then the corners: each in the walk's order.
    const sides: Found[][] = [[], [], [], []];
    const corners: (Found | undefined)[] = [];
    for (const m of ring) {
      if (may(m)) {
        sideEntries(n, m, sides);
        const c = cornerEntry(n, m);
        if (c) {
          corners[c.k] ??= c.found;
        }
      }
    }
    const out = sides.flat();
    for (const c of corners) {
      if (c) {
        out.push(c);
      }
    }
    return out;
  }
}

type Found = { node: QuadNode; portal: [number, number] };

const across = (lo: number, hi: number, a: number, b: number): boolean =>
  Math.max(lo, a) < Math.min(hi, b);

/**
 * Leaf `m` added to each of `sides`, east, west, north and south of `n`, along which it shares
 * an edge of positive length with `n`, entered at the shared edge's midpoint.
 */
function sideEntries(n: QuadNode, m: QuadNode, sides: Found[][]): void {
  const { x, y } = n;
  const x1 = x + n.size;
  const y1 = y + n.size;
  const mx1 = m.x + m.size;
  const my1 = m.y + m.size;
  if (across(y, y1, m.y, my1)) {
    if (m.x <= x1 && x1 < mx1) {
      sides[0]?.push({ node: m, portal: [x1, mid(y, y1, m.y, my1)] });
    }
    if (m.x < x && x <= mx1) {
      sides[1]?.push({ node: m, portal: [x, mid(y, y1, m.y, my1)] });
    }
  }
  if (across(x, x1, m.x, mx1)) {
    if (m.y <= y1 && y1 < my1) {
      sides[2]?.push({ node: m, portal: [mid(x, x1, m.x, mx1), y1] });
    }
    if (m.y < y && y <= my1) {
      sides[3]?.push({ node: m, portal: [mid(x, x1, m.x, mx1), y] });
    }
  }
}

/**
 * Leaf `m` when it meets `n` at a corner alone, its own, entered through it: `k` 0 to 3 for the
 * corners north-east, north-west, south-east and south-west. A diagonal channel one square wide
 * is a chain of such squares; a path through the corner lies in the two squares, so every point
 * within the corridor half-width of it lies in one of the two footprints their box verdicts cover.
 */
function cornerEntry(n: QuadNode, m: QuadNode): { k: number; found: Found } | undefined {
  const x1 = n.x + n.size;
  const y1 = n.y + n.size;
  const east = m.x === x1;
  const north = m.y === y1;
  if (!(east || m.x + m.size === n.x) || !(north || m.y + m.size === n.y)) {
    return undefined;
  }
  const portal: [number, number] = [east ? x1 : n.x, north ? y1 : n.y];
  return { k: (east ? 0 : 1) + (north ? 0 : 2), found: { node: m, portal } };
}

/** Midpoint of the overlap of [a0, a1] and [b0, b1]. */
function mid(a0: number, a1: number, b0: number, b1: number): number {
  return (Math.max(a0, b0) + Math.min(a1, b1)) / 2;
}

export const isFree = (n: QuadNode): boolean => n.state === "free";

export function centre(n: QuadNode): [number, number] {
  return [n.x + n.size / 2, n.y + n.size / 2];
}
