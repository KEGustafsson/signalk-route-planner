import { Heap } from "./heap";
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
   * The heuristic's weight, at least 1: weighted A*, whose path costs at most this many
   * times the cheapest, for far fewer squares classified in a maze of islands. 1 when absent.
   */
  greed?: number;
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
  g: Map<number, number>;
  back: Map<number, { prev: QuadNode; portal: XY }>;
  closed: Map<number, QuadNode>;
  open: Heap<QuadNode>;
}

/** A leaf's weight, 1 while it is not classified: a lower bound, so the queue order holds. */
const weightOf = (st: State, n: QuadNode): number => (n.state === "unknown" ? 1 : st.weight(n));

/** Queues `m`, reached from `n` through `portal`, when that is cheaper than what it has. */
function relax(st: State, n: QuadNode, m: QuadNode, portal: XY): void {
  if (st.closed.has(m.id)) {
    return;
  }
  const gm =
    (st.g.get(n.id) as number) +
    dist(st.pos(n), portal) * weightOf(st, n) +
    dist(portal, st.pos(m)) * weightOf(st, m);
  if (gm < (st.g.get(m.id) ?? Infinity)) {
    st.g.set(m.id, gm);
    st.back.set(m.id, { prev: n, portal });
    st.open.push(m, gm + st.greed * dist(st.pos(m), st.goal));
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
  if (b && st.weight(n) !== 1) {
    // Queued at weight 1: queue it again at its own.
    st.g.delete(n.id);
    relax(st, b.prev, n, b.portal);
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
  const st: State = {
    tree,
    pos: (n) => (n === from ? start : n === to ? goal : centre(n)),
    weight,
    enter,
    goal,
    greed: Math.max(1, limits.greed ?? 1),
    g: new Map([[from.id, 0]]),
    back: new Map(),
    closed: new Map(),
    open: new Heap<QuadNode>()
  };
  st.open.push(from, dist(start, goal));
  let expanded = 0;
  while (st.open.size > 0) {
    const n = st.open.pop();
    if (st.closed.has(n.id) || n.state === "split") {
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

/** The per-metre weight of a leaf and whether it may be entered at all. */
function weighing(limits: SearchLimits): {
  weight: (n: QuadNode) => number;
  enter: (n: QuadNode) => boolean;
} {
  const weight = limits.weight ?? ((n: QuadNode) => (n.state === "free" ? 1 : Infinity));
  return { weight, enter: (n) => Number.isFinite(weight(n)) };
}

function walkBack(
  end: QuadNode,
  from: QuadNode,
  back: Map<number, { prev: QuadNode; portal: XY }>,
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
