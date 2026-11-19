import { frameAt } from "../../src/foundation/geo";
import type { Session, Verdict } from "../../src/oracle/contract";
import { aStar } from "../../src/search/astar";
import { QuadTree } from "../../src/search/quadtree";

/** The quadtree's adjacency, on a chart where only chosen unit squares are free. */

function treeWith(free: (x: number, y: number) => boolean, queries = { n: 0 }) {
  const holder: { tree?: QuadTree } = {};
  const verdict = (ok: boolean): Verdict => ({
    status: ok ? "ok" : "fail",
    risk: ok ? 0 : 1,
    flags: []
  });
  const session: Session = {
    halfWidth: 0,
    box(sw, ne) {
      queries.n++;
      const t = holder.tree as QuadTree;
      const [x0, y0] = t.units(sw);
      const [x1, y1] = t.units(ne);
      const x = Math.round(x0);
      const y = Math.round(y0);
      return verdict(Math.round(x1 - x0) === 1 && Math.round(y1 - y0) === 1 && free(x, y));
    },
    segment: () => verdict(false),
    work: () => 0,
    pause: () => Promise.resolve()
  };
  const tree = new QuadTree(
    { frame: frameAt([22, 60]), x0: 0, y0: 0, unit: 10, side: 8, maxLeaf: 8 },
    session
  );
  holder.tree = tree;
  return tree;
}

const limits = { exhausted: () => false, pause: () => Promise.resolve(), every: 64 };

describe("quadtree adjacency", () => {
  test("a diagonal channel one square wide is crossed through the squares' shared corners", async () => {
    const tree = treeWith((x, y) => x === y);
    const from = tree.leafAt(0.5, 0.5);
    const to = tree.leafAt(7.5, 7.5);
    expect(from?.state).toBe("free");
    const r = await aStar(tree, from as never, [0.5, 0.5], to as never, [7.5, 7.5], limits);
    expect(r.found).toBe(true);
    // Through the corners (1,1) … (7,7), never off the diagonal.
    const points = r.found ? r.points : [];
    expect(points.every(([x, y]) => Math.abs(x - y) < 1e-9)).toBe(true);
  });

  test("squares that do not meet, even at a corner, are not joined", async () => {
    const tree = treeWith((x, y) => (x === 0 && y === 0) || (x === 2 && y === 2));
    const r = await aStar(
      tree,
      tree.leafAt(0.5, 0.5) as never,
      [0.5, 0.5],
      tree.leafAt(2.5, 2.5) as never,
      [2.5, 2.5],
      limits
    );
    expect(r.found).toBe(false);
  });

  test("an edge neighbour is not also a corner neighbour", () => {
    const tree = treeWith((x, y) => y === 0 && x < 3);
    const n = tree.leafAt(1.5, 0.5);
    const ids = tree.neighbours(n as never).map((m) => m.node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(2);
  });

  test("an expansion stops classifying its neighbours at the work limit", async () => {
    // Only the start square and the far corner are free: the start's neighbours split down
    // to unit squares, many queries in one expansion.
    const queries = { n: 0 };
    const tree = treeWith((x, y) => (x === 0 && y === 0) || (x === 7 && y === 7), queries);
    const from = tree.leafAt(0.5, 0.5);
    const to = tree.leafAt(7.5, 7.5);
    const cap = queries.n + 1;
    const r = await aStar(tree, from as never, [0.5, 0.5], to as never, [7.5, 7.5], {
      ...limits,
      exhausted: () => queries.n >= cap
    });
    expect(r).toMatchObject({ found: false, reason: "work" });
    expect(queries.n).toBeLessThanOrEqual(cap);
  });
});
