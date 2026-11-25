import { Heap } from "./heap";
import { IdMap } from "./id-map";
import type { QuadNode, QuadTree } from "./quadtree";
import { centre } from "./quadtree";

/**
 * A* over the free leaves of a quadtree (plan §4.1 step 3). A leaf is entered
 * through the midpoint of the edge it shares with the leaf before; its
 * position is its centre, except the start and goal leaves, whose positions are
 * the start and goal points. The cost is the length of that polyline and the
 * heuristic the straight line to the goal, which never overestimates it: every
 * leaf's weight per metre is at least 1.
 *
 * Lazy (plan §6, work budget): a neighbour not yet classified is queued at the
 * cost it would have at weight 1, and classified only when it comes off the queue.
 * A square that turns out free is queued again at its real cost; one that splits
 * hands its children to the expanded squares beside them. Squares the search never
 * reaches are never asked about.
 */

type XY = [number, number];

export interface SearchLimits {
  /**
   * Cost per metre in a leaf, Infinity where the search may not go; absent, free
   * leaves cost 1 and no other leaf is entered.
   */
  weight?(n: QuadNode): number;
  /** True once the search has used its work; it then stops. */
  exhausted(): boolean;
  /** Called every `every` expansions, so other work can run. */
  pause(): Promise<void>;
  every: number;
  /**
   * The heuristic's weight, at least 1: weighted A*, for far fewer squares classified in a maze
   * of islands. Unsteered, its path costs at most this many times the cheapest; a `heuristic`
   * may overestimate, so a steered search's path has no such bound. 1 when absent.
   */
  greed?: number;
  /**
   * The estimate of the way on from a point to the goal, units; absent, the straight line. A
   * steered search's (`guide.ts`) follows a coarse path: it orders the search, and may
   * overestimate, so it lifts `greed`'s bound on the path's cost.
   */
  heuristic?(p: XY): number;
  /**
   * A length, units, no path at or above which is wanted: a square whose length so far, along
   * its cheapest way in, and straight line on to the goal reach it is never queued. The order
   * stays by cost; with a route in hand that a path must be shorter than, the search spends no
   * work on squares no such path can cross.
   */
  bound?: number;
}

export type SearchResult =
  | { found: true; points: XY[]; expanded: number }
  | { found: false; reason: "unreachable" | "work"; expanded: number };

const dist = (a: XY, b: XY): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

interface State {
  tree: QuadTree;
  pos: (n: QuadNode) => XY;
  weight: (n: QuadNode) => number;
  enter: (n: QuadNode) => boolean;
  goal: XY;
  greed: number;
  /** No square is queued whose lower bound on a path's length reaches this (`SearchLimits.bound`). */
  bound: number;
  /** Each square's length along its cheapest way in, units. */
  len: IdMap<number>;
  /** The estimate from a point, and a lower bound of it over a square not yet classified. */
  h: (p: XY) => number;
  hSquare: (n: QuadNode) => number;
  g: IdMap<number>;
  back: IdMap<{ prev: QuadNode; portal: XY }>;
  closed: IdMap<QuadNode>;
  open: Heap<QuadNode>;
  /** The priority each square was last queued at: an entry queued earlier is stale. */
  queued: IdMap<number>;
}

/** A leaf's weight, 1 while it is not classified: a lower bound, so the queue order holds. */
const weightOf = (st: State, n: QuadNode): number => (n.state === "unknown" ? 1 : st.weight(n));

/** Distance from point `p` to the square of `n`: 0 inside it. */
function toSquare(n: QuadNode, p: XY): number {
  const dx = Math.max(n.x - p[0], 0, p[0] - (n.x + n.size));
  const dy = Math.max(n.y - p[1], 0, p[1] - (n.y + n.size));
  return Math.hypot(dx, dy);
}

/**
 * Queues `m`, reached from `n` through `portal`, when that is cheaper than what it has. A
 * square not yet classified and larger than a unit may split, and a child of it can be
 * cheaper than its centre: it is queued at a lower bound for every square in it (the cost to
 * `n`, on to the square's nearest point, and the heuristic from the square's nearest point to
 * the goal), and at its own cost once classified.
 */
function relax(st: State, n: QuadNode, m: QuadNode, portal: XY): void {
  if (st.closed.has(m.id)) {
    return;
  }
  const gn = st.g.get(n.id) as number;
  const ln = st.len.get(n.id) ?? 0;
  const gm =
    gn + dist(st.pos(n), portal) * weightOf(st, n) + dist(portal, st.pos(m)) * weightOf(st, m);
  const lm = ln + dist(st.pos(n), portal) + dist(portal, st.pos(m));
  const better = gm < (st.g.get(m.id) ?? Infinity);
  if (better) {
    st.g.set(m.id, gm);
    st.len.set(m.id, lm);
    st.back.set(m.id, { prev: n, portal });
  }
  if (m.state === "unknown" && m.size > 1) {
    if (ln + toSquare(m, st.pos(n)) + toSquare(m, st.goal) >= st.bound) {
      return;
    }
    // The centre's cost and the square's key are separate: the key is the lowest bound any
    // predecessor gives, so a later one with a cheaper centre but a higher bound keeps it.
    const f = gn + toSquare(m, st.pos(n)) * weightOf(st, n) + st.greed * st.hSquare(m);
    if (f < (st.queued.get(m.id) ?? Infinity)) {
      st.queued.set(m.id, f);
      st.open.push(m, f);
    }
    return;
  }
  if (better && lm + dist(st.pos(m), st.goal) < st.bound) {
    const f = gm + st.greed * st.h(st.pos(m));
    st.queued.set(m.id, f);
    st.open.push(m, f);
  }
}

/**
 * Classifies a queued square. A free one is queued again at its real cost (true when it
 * may be expanded now); one that splits passes its children to the expanded squares
 * beside them; one that may not be entered is dropped.
 */
function classify(st: State, n: QuadNode): boolean {
  st.tree.resolve(n);
  if (n.state === "split") {
    st.g.delete(n.id);
    for (const c of n.children as QuadNode[]) {
      for (const { node: m, portal } of st.tree.neighbours(c, (q) => st.closed.has(q.id), false)) {
        if (st.closed.has(m.id)) {
          relax(st, m, c, portal);
        }
      }
    }
    return false;
  }
  if (!st.enter(n)) {
    st.closed.set(n.id, n);
    return false;
  }
  const b = st.back.get(n.id);
  if (b && (st.weight(n) !== 1 || n.size > 1)) {
    // Queued at weight 1, or at a lower bound: queue it again at its own cost, from
    // whichever expanded square beside it is the cheapest way in (the portal sets the
    // length inside it).
    st.g.delete(n.id);
    relax(st, b.prev, n, b.portal);
    for (const { node: m, portal } of st.tree.neighbours(n, (q) => st.closed.has(q.id), false)) {
      if (st.closed.has(m.id)) {
        relax(st, m, n, portal);
      }
    }
    return false;
  }
  return true;
}

/**
 * The path from `start` (a point in leaf `from`) to `goal` (a point in leaf
 * `to`), both free, as unit-coordinate points: start, edge midpoints and
 * leaf centres, goal.
 */
export async function aStar(
  tree: QuadTree,
  from: QuadNode,
  start: XY,
  to: QuadNode,
  goal: XY,
  limits: SearchLimits
): Promise<SearchResult> {
  const { weight, enter } = weighing(limits);
  const { h, hSquare } = estimates(limits, goal);
  const st: State = {
    tree,
    pos: (n) => (n === from ? start : n === to ? goal : centre(n)),
    weight,
    enter,
    goal,
    greed: Math.max(1, limits.greed ?? 1),
    bound: limits.bound ?? Infinity,
    len: new IdMap([[from.id, 0]]),
    h,
    hSquare,
    g: new IdMap([[from.id, 0]]),
    back: new IdMap(),
    closed: new IdMap(),
    open: new Heap<QuadNode>(),
    queued: new IdMap([[from.id, h(start)]])
  };
  if (dist(start, goal) >= st.bound) {
    return { found: false, reason: "unreachable", expanded: 0 };
  }
  st.open.push(from, h(start));
  let expanded = 0;
  while (st.open.size > 0) {
    const key = st.open.peekKey();
    const n = st.open.pop();
    // A square queued again at another priority is expanded at that one, not this.
    if (st.closed.has(n.id) || n.state === "split" || st.queued.get(n.id) !== key) {
      continue;
    }
    if (n.state === "unknown" && !classify(st, n)) {
      if (limits.exhausted()) {
        return { found: false, reason: "work", expanded };
      }
      continue;
    }
    if (n === to) {
      return { found: true, points: walkBack(n, from, st.back, st.pos), expanded };
    }
    st.closed.set(n.id, n);
    expanded++;
    if (expanded % limits.every === 0) {
      await limits.pause();
    }
    if (limits.exhausted()) {
      return { found: false, reason: "work", expanded };
    }
    for (const { node: m, portal } of tree.neighbours(n, enter, false)) {
      relax(st, n, m, portal);
    }
  }
  return { found: false, reason: "unreachable", expanded };
}

/**
 * The estimate on to `goal`: the straight line, or the limits' heuristic, never below the
 * straight line. A square's bound is its nearest point's straight line, or the heuristic at its
 * centre less twice its half diagonal, whichever is more.
 */
function estimates(
  limits: SearchLimits,
  goal: XY
): { h: (p: XY) => number; hSquare: (n: QuadNode) => number } {
  const guide = limits.heuristic;
  if (!guide) {
    return { h: (p) => dist(p, goal), hSquare: (n) => toSquare(n, goal) };
  }
  const h = (p: XY): number => Math.max(dist(p, goal), guide(p));
  const seen = new IdMap<number>();
  const hSquare = (n: QuadNode): number => {
    let v = seen.get(n.id);
    if (v === undefined) {
      v = Math.max(toSquare(n, goal), guide(centre(n)) - Math.SQRT2 * n.size);
      seen.set(n.id, v);
    }
    return v;
  };
  return { h, hSquare };
}

/** The per-metre weight of a leaf and whether it may be entered at all. */
function weighing(limits: SearchLimits): {
  weight: (n: QuadNode) => number;
  enter: (n: QuadNode) => boolean;
} {
  const of = limits.weight ?? ((n: QuadNode) => (n.state === "free" ? 1 : Infinity));
  // A classified leaf's weight does not change: told once, as each relaxation asks it again.
  const kept = new IdMap<number>();
  const weight = (n: QuadNode): number => {
    if (n.state === "unknown" || n.state === "split") {
      return of(n);
    }
    let w = kept.get(n.id);
    if (w === undefined) {
      w = of(n);
      kept.set(n.id, w);
    }
    return w;
  };
  return { weight, enter: (n) => Number.isFinite(weight(n)) };
}

function walkBack(
  end: QuadNode,
  from: QuadNode,
  back: IdMap<{ prev: QuadNode; portal: XY }>,
  pos: (n: QuadNode) => XY
): XY[] {
  const points: XY[] = [pos(end)];
  let n = end;
  while (n !== from) {
    const b = back.get(n.id) as { prev: QuadNode; portal: XY };
    points.push(b.portal);
    n = b.prev;
    points.push(pos(n));
  }
  return points.reverse();
}
