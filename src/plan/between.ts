import { aStar } from "../search/astar";
import { cheapest } from "../search/anytime";
import type { Guide } from "../search/guide";
import type { QuadNode, QuadTree } from "../search/quadtree";
import type { Session } from "../oracle/contract";
import type { Mode } from "./modes";
import type { PlanOptions } from "./options";

/** A*'s heuristic weight where a weight carries a preference (`Mode.fine`). */
const FINE_GREED = 1.05;

/** The work the search may do in all. */
const searchWork = (opts: PlanOptions): number => opts.maxWork * opts.searchShare;

/** A joined end: its leaf, and where in it the search starts or ends, unit coordinates. */
interface End {
  leaf: QuadNode;
  at: [number, number];
}

/** A* between the joined ends: ordered by the guide, through the ends' squares, when there is one. */
export async function between(
  tree: QuadTree,
  session: Session,
  [start, goal]: [End, End],
  opts: PlanOptions,
  how: { mode: Mode; exhausted: () => boolean; guide?: () => Promise<Guide | undefined> }
): ReturnType<typeof aStar> {
  if (start.leaf === goal.leaf) {
    return { found: true, points: [start.at, goal.at], expanded: 0 };
  }
  // A preference (a risk cost or lines) is finer than the guide's estimate, which would drown it.
  const g = how.mode.fine ? undefined : (await how.guide?.())?.through(start.at, goal.at);
  // A risk cost or a line is a preference smaller than weighted A*'s slack: a slack of
  // FINE_GREED keeps every one worth more than it.
  const first = how.mode.fine ? Math.min(opts.greed, FINE_GREED) : opts.greed;
  return cheapest(
    tree,
    (greed) => {
      // The finer pass goes without the guide, which may have led the first the long way: an
      // anytime search, the guided route first, a shorter one with the work to find it. It takes
      // at most half the work left, so the stages after it keep the rest.
      const guided = greed === first;
      const stop = guided ? Infinity : session.work() + (searchWork(opts) - session.work()) / 2;
      return aStar(tree, start.leaf, start.at, goal.leaf, goal.at, {
        exhausted: () => how.exhausted() || session.work() >= stop,
        pause: () => session.pause(),
        every: 64,
        weight: how.mode.weight,
        greed,
        ...(g && guided && { heuristic: (p: [number, number]) => g.to(p) })
      });
    },
    { first, fine: FINE_GREED },
    how.mode.weight
  );
}
