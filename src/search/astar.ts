import type { QuadNode, QuadTree } from "./quadtree";
import { centre } from "./quadtree";

/**
 * A* over the free leaves of a quadtree (plan §4.1 step 3). A leaf is entered
 * through the midpoint of the edge it shares with the leaf before; its
 * position is its centre, except the start and goal leaves, whose positions are
 * the start and goal points. The cost is the length of that polyline and the
 * heuristic the straight line to the goal, which never overestimates it.
 */

type XY = [number, number];

export interface SearchLimits {
  /** True once the search has used its work; it then stops. */
  exhausted(): boolean;
  /** Called every `every` expansions, so other work can run. */
  pause(): Promise<void>;
  every: number;
}

export type SearchResult =
  | { found: true; points: XY[]; expanded: number }
  | { found: false; reason: "unreachable" | "work"; expanded: number };

const dist = (a: XY, b: XY): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

class Heap {
  private readonly a: { n: QuadNode; f: number }[] = [];
  get size(): number {
    return this.a.length;
  }
  push(n: QuadNode, f: number): void {
    const a = this.a;
    a.push({ n, f });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((a[p] as { f: number }).f <= f) {
        break;
      }
      [a[i], a[p]] = [a[p] as { n: QuadNode; f: number }, a[i] as { n: QuadNode; f: number }];
      i = p;
    }
  }
  pop(): QuadNode {
    const a = this.a;
    const top = a[0] as { n: QuadNode; f: number };
    const last = a.pop() as { n: QuadNode; f: number };
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && (a[l] as { f: number }).f < (a[m] as { f: number }).f) {
          m = l;
        }
        if (r < a.length && (a[r] as { f: number }).f < (a[m] as { f: number }).f) {
          m = r;
        }
        if (m === i) {
          break;
        }
        [a[i], a[m]] = [a[m] as { n: QuadNode; f: number }, a[i] as { n: QuadNode; f: number }];
        i = m;
      }
    }
    return top.n;
  }
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
  const pos = (n: QuadNode): XY => (n === from ? start : n === to ? goal : centre(n));
  const g = new Map<number, number>([[from.id, 0]]);
  const back = new Map<number, { prev: QuadNode; portal: XY }>();
  const closed = new Set<number>();
  const open = new Heap();
  open.push(from, dist(start, goal));
  let expanded = 0;
  while (open.size > 0) {
    const n = open.pop();
    if (closed.has(n.id)) {
      continue;
    }
    if (n === to) {
      return { found: true, points: walkBack(n, from, back, pos), expanded };
    }
    closed.add(n.id);
    expanded++;
    if (expanded % limits.every === 0) {
      await limits.pause();
    }
    if (limits.exhausted()) {
      return { found: false, reason: "work", expanded };
    }
    const gn = g.get(n.id) as number;
    const p = pos(n);
    for (const { node: m, portal } of tree.neighbours(n)) {
      if (closed.has(m.id)) {
        continue;
      }
      const gm = gn + dist(p, portal) + dist(portal, pos(m));
      if (gm < (g.get(m.id) ?? Infinity)) {
        g.set(m.id, gm);
        back.set(m.id, { prev: n, portal });
        open.push(m, gm + dist(pos(m), goal));
      }
    }
  }
  return { found: false, reason: "unreachable", expanded };
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
