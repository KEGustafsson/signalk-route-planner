import type { LonLat } from "../foundation/geo";
import type { Session } from "../oracle/contract";
import { aStar } from "../search/astar";
import type { PassRule } from "../search/passes";
import type { QuadNode, TreeShape } from "../search/quadtree";
import { QuadTree } from "../search/quadtree";
import { Guide } from "../search/guide";
import type { PlanOptions } from "./options";

/**
 * Steering (plan §6): a coarse pass first, A* over the same region's quadtree cut no finer than
 * `steerCell`, where a coarse square that does not pass whole may still hold a way through and
 * costs `STEER_MAYBE` times a free one. Its path gives the fine search a tube to search first
 * (`tube.ts`), widened in turn and at last dropped, so the steered search finds every route the
 * unsteered one finds, and asks first about the water along the likely way. The coarse squares
 * are the fine tree's own squares of that size, so the fine search asks the chart about none of
 * them again (`memoBoxes`).
 */

type XY = [number, number];

/** A coarse square that does not pass whole costs this many times a free one. */
export const STEER_MAYBE = 6;
/** The coarse region has at least this many squares on a side, or the search is not steered. */
const MIN_COARSE_SIDE = 8;
/** Flags of a coarse square no finer square in it can pass either: no chart, never asked. */
const CLOSED = new Set(["NO_COVERAGE", "BOX_TOO_LARGE"]);

/** The coarse shape over `shape`: squares `2^k` of its units, `2^k` the most within `cell`. */
export function coarseShape(shape: TreeShape, cell: number): TreeShape | undefined {
  let f = 1;
  while (f * 2 * shape.unit <= cell && shape.side / (f * 2) >= MIN_COARSE_SIDE) {
    f *= 2;
  }
  if (f === 1) {
    return undefined;
  }
  return {
    ...shape,
    unit: shape.unit * f,
    side: shape.side / f,
    maxLeaf: Math.max(1, shape.maxLeaf / f)
  };
}

/** The coarse pass's weight: free water 1, a coarse square that may hold a way STEER_MAYBE. */
function coarseWeight(n: QuadNode): number {
  if (n.state === "free") {
    return 1;
  }
  if (n.size > 1 || n.state === "unknown" || n.state === "split") {
    return Infinity;
  }
  return n.verdict?.flags.some((f) => CLOSED.has(f)) ? Infinity : STEER_MAYBE;
}

/**
 * The coarse path for a search from `start` to `goal` (the fine tree's units) on `session`, and
 * for each of its segments whether it crosses a coarse square that may hold a way through, or
 * undefined when the region is too small to steer or the coarse pass finds no way within its
 * share of the work.
 */
export async function coarsePath(
  shape: TreeShape,
  session: Session,
  rule: PassRule,
  [start, goal]: [XY, XY],
  opts: PlanOptions
): Promise<Coarse | undefined> {
  const coarse = coarseShape(shape, opts.steerCell);
  // A corridor's index already holds the search to the survey's coarse route (`corridor.ts`).
  if (!coarse || opts.steerShare <= 0 || session.within) {
    return undefined;
  }
  const f = coarse.unit / shape.unit;
  const tree = new QuadTree(coarse, session, rule);
  const limit = session.work() + opts.maxWork * opts.searchShare * opts.steerShare;
  const s: XY = [start[0] / f, start[1] / f];
  const g: XY = [goal[0] / f, goal[1] / f];
  const from = tree.leafAt(s[0], s[1]);
  const to = tree.leafAt(g[0], g[1]);
  if (!from || !to || !Number.isFinite(coarseWeight(from)) || !Number.isFinite(coarseWeight(to))) {
    return undefined;
  }
  const found =
    from === to
      ? { found: true as const, points: [s, g] }
      : await aStar(tree, from, s, to, g, {
          weight: coarseWeight,
          exhausted: () => session.work() >= limit,
          pause: () => session.pause(),
          every: 64,
          greed: opts.steerGreed
        });
  if (!found.found) {
    return undefined;
  }
  // A segment lies in one coarse square: the one holding its middle.
  const maybe = found.points.slice(1).map((b, i) => {
    const a = found.points[i] as XY;
    const leaf = tree.leafAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    return leaf !== undefined && leaf.state !== "free";
  });
  const path = found.points.map(([x, y]): XY => [x * f, y * f]);
  path[0] = start;
  path[path.length - 1] = goal;
  return { path, maybe };
}

/** A coarse path, fine units, and which of its segments may hold no way through. */
export interface Coarse {
  path: XY[];
  maybe: boolean[];
}

/**
 * The guides for the searches between `ends` in `tree`, by the weight a metre of
 * the coarse path through a square that may hold no way through counts for: 1 for the strict
 * search, `steerRisk` for the fallback, which will likely have to cross risk there. The coarse
 * pass runs once, when a search first has both its ends joined.
 */
export function guides(
  tree: QuadTree,
  session: Session,
  rule: PassRule,
  ends: [LonLat, LonLat],
  opts: PlanOptions
): (risk: number) => () => Promise<Guide | undefined> {
  let made: Promise<Coarse | undefined> | undefined;
  const at: [XY, XY] = [tree.units(ends[0]), tree.units(ends[1])];
  return (risk) => async () => {
    const c = await (made ??= coarsePath(tree.shape, session, rule, at, opts));
    return (
      c &&
      new Guide(
        c.path,
        c.maybe.map((m) => (m ? risk : 1))
      )
    );
  };
}
