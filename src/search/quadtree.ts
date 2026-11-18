import type { Frame, LonLat } from "../foundation/geo";
import { grownBoxKm2 } from "../foundation/geo";
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
 * Any other verdict splits the square, down to one unit; a one-unit square
 * that is `marginal` stays passable at a cost (search/fallback.ts), and any other
 * that does not pass is blocked, remembered as unverified when its verdict said so.
 */

/** The largest box with its buffer the tree sends, km²: under the planning API's 25. */
export const MAX_BOX_KM2 = 24;

/** A one-unit square too large to ask about: never free, counted as unverified. */
const TOO_LARGE = { status: "unverified" as const, risk: 0, flags: ["BOX_TOO_LARGE"] };

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
  /** Squares classified so far. */
  classified = 0;
  /** One-unit squares found unverified. */
  unverified = 0;

  constructor(
    readonly shape: TreeShape,
    private readonly session: Session,
    private readonly rule: PassRule = OK_ONLY
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
      if (n.size > 1) {
        this.split(n);
      } else {
        n.verdict = { ...TOO_LARGE, flags: [...TOO_LARGE.flags] };
        n.state = "unverified";
        this.unverified++;
      }
      return;
    }
    const v = this.session.box(sw, ne);
    this.classified++;
    n.verdict = { status: v.status, flags: v.flags, risk: v.risk };
    if (passes(v, this.rule)) {
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
   * is no larger than `maxLeaf` (larger ones split without asking).
   */
  leaves(touches: (n: QuadNode) => boolean, classify = true): QuadNode[] {
    const out: QuadNode[] = [];
    const stack = [this.root];
    while (stack.length > 0) {
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
   * nearer than the k-th leaf it returns, not the whole disc.
   */
  nearest(
    ux: number,
    uy: number,
    radius: number,
    accept: (n: QuadNode) => boolean,
    k: number
  ): QuadNode[] {
    const away = (n: QuadNode): number =>
      Math.hypot(
        Math.max(n.x - ux, 0, ux - (n.x + n.size)),
        Math.max(n.y - uy, 0, uy - (n.y + n.size))
      );
    const open = new Heap<QuadNode>();
    open.push(this.root, away(this.root));
    const out: QuadNode[] = [];
    while (open.size > 0 && out.length < k && open.peekKey() <= radius) {
      const n = open.pop();
      this.resolve(n);
      if (n.state === "split") {
        for (const c of n.children as QuadNode[]) {
          open.push(c, away(c));
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
   * Free leaves sharing an edge of positive length with `n`, with the shared edge's
   * midpoint, and those meeting it at a corner only, with that corner.
   */
  neighbours(
    n: QuadNode,
    enter: (m: QuadNode) => boolean = isFree,
    classify = true
  ): { node: QuadNode; portal: [number, number] }[] {
    const out: { node: QuadNode; portal: [number, number] }[] = [];
    const { x, y, size } = n;
    const across = (lo: number, hi: number, a: number, b: number) =>
      Math.max(lo, a) < Math.min(hi, b);
    const sides: [(m: QuadNode) => boolean, (m: QuadNode) => [number, number]][] = [
      // east, west, north, south
      [
        (m) => m.x <= x + size && x + size < m.x + m.size && across(y, y + size, m.y, m.y + m.size),
        (m) => [x + size, mid(y, y + size, m.y, m.y + m.size)]
      ],
      [
        (m) => m.x < x && x <= m.x + m.size && across(y, y + size, m.y, m.y + m.size),
        (m) => [x, mid(y, y + size, m.y, m.y + m.size)]
      ],
      [
        (m) => m.y <= y + size && y + size < m.y + m.size && across(x, x + size, m.x, m.x + m.size),
        (m) => [mid(x, x + size, m.x, m.x + m.size), y + size]
      ],
      [
        (m) => m.y < y && y <= m.y + m.size && across(x, x + size, m.x, m.x + m.size),
        (m) => [mid(x, x + size, m.x, m.x + m.size), y]
      ]
    ];
    // Unclassified: a candidate the caller classifies when it gets to it.
    const may = (m: QuadNode): boolean => (!classify && m.state === "unknown") || enter(m);
    for (const [touches, portal] of sides) {
      for (const m of this.leaves(touches, classify)) {
        if (may(m) && m !== n) {
          out.push({ node: m, portal: portal(m) });
        }
      }
    }
    return [...out, ...this.cornerNeighbours(n, may, classify)];
  }

  /**
   * Free leaves that meet `n` at a corner only, entered through that corner. A
   * diagonal channel one square wide is a chain of such squares. A path through the
   * corner lies in the two squares, so every point within the corridor half-width of
   * it lies in one of the two footprints their box verdicts cover.
   */
  private cornerNeighbours(
    n: QuadNode,
    enter: (m: QuadNode) => boolean,
    classify: boolean
  ): { node: QuadNode; portal: [number, number] }[] {
    const out: { node: QuadNode; portal: [number, number] }[] = [];
    for (const [dx, dy] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1]
    ] as const) {
      const cx = dx > 0 ? n.x + n.size : n.x;
      const cy = dy > 0 ? n.y + n.size : n.y;
      const m = this.diagonal(cx, cy, dx, dy, classify);
      if (m && enter(m)) {
        out.push({ node: m, portal: [cx, cy] });
      }
    }
    return out;
  }

  /** The leaf beyond corner (cx, cy) in direction (dx, dy), when it has that corner as its own. */
  private diagonal(
    cx: number,
    cy: number,
    dx: 1 | -1,
    dy: 1 | -1,
    classify: boolean
  ): QuadNode | undefined {
    const side = this.shape.side;
    const px = cx + dx * 1e-6;
    const py = cy + dy * 1e-6;
    if (px < 0 || py < 0 || px > side || py > side) {
      return undefined;
    }
    const m = this.leaves(
      (q) => px >= q.x && px < q.x + q.size && py >= q.y && py < q.y + q.size,
      classify
    )[0];
    if (!m) {
      return undefined;
    }
    const cornerX = dx > 0 ? m.x === cx : m.x + m.size === cx;
    const cornerY = dy > 0 ? m.y === cy : m.y + m.size === cy;
    return cornerX && cornerY ? m : undefined;
  }
}

/** Midpoint of the overlap of [a0, a1] and [b0, b1]. */
function mid(a0: number, a1: number, b0: number, b1: number): number {
  return (Math.max(a0, b0) + Math.min(a1, b1)) / 2;
}

export const isFree = (n: QuadNode): boolean => n.state === "free";

export function centre(n: QuadNode): [number, number] {
  return [n.x + n.size / 2, n.y + n.size / 2];
}
