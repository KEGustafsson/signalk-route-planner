import fc from "fast-check";
import { frameAt } from "../../src/foundation/geo";
import type { Session, Verdict } from "../../src/oracle/contract";
import { aStar } from "../../src/search/astar";
import { strictWeight } from "../../src/search/fallback";
import { QuadTree } from "../../src/search/quadtree";

/** The quadtree's adjacency, on a chart where only chosen unit squares are free. */

function treeWith(free: (x: number, y: number) => boolean, queries = { n: 0 }) {
  const holder: { tree?: QuadTree; boxes: number } = { boxes: 0 };
  const verdict = (ok: boolean): Verdict => ({
    status: ok ? "ok" : "fail",
    risk: ok ? 0 : 1,
    flags: []
  });
  const session: Session = {
    halfWidth: 0,
    box(sw, ne) {
      holder.boxes++;
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
  return Object.assign(tree, { boxesAsked: () => holder.boxes });
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
    const cap = queries.n + 3;
    const r = await aStar(tree, from as never, [0.5, 0.5], to as never, [7.5, 7.5], {
      ...limits,
      exhausted: () => queries.n >= cap
    });
    expect(r).toMatchObject({ found: false, reason: "work" });
    expect(queries.n).toBeLessThanOrEqual(cap);
  });
});

describe("nearest free squares", () => {
  test("best first: the nearest accepted squares, without classifying the whole disc", () => {
    const tree = treeWith((x, y) => (x === 1 && y === 6) || (x === 5 && y === 5));
    const near = tree.nearest(0.5, 0.5, 8, (n) => n.state === "free", 1);
    expect(near.map((n) => [n.x, n.y])).toEqual([[1, 6]]);
    // Resolving every square of the 8 × 8 region asks 1 + 4 + 16 + 64 = 85 boxes.
    expect(tree.boxesAsked()).toBeLessThan(85);
    // Nothing within the radius: none, and nothing beyond it is asked about.
    const none = treeWith(() => false);
    expect(none.nearest(0.5, 0.5, 2, (n) => n.state === "free", 1)).toEqual([]);
    expect(none.boxesAsked()).toBeLessThan(85);
  });
});

describe("weighted A*", () => {
  test("with a heuristic weight the path still joins start and goal through free squares", async () => {
    const tree = treeWith((x, y) => x === 0 || y === 7 || x === 7);
    const from = tree.leafAt(0.5, 0.5);
    const to = tree.leafAt(7.5, 0.5);
    const r = await aStar(tree, from as never, [0.5, 0.5], to as never, [7.5, 0.5], {
      ...limits,
      greed: 1.5
    });
    expect(r.found).toBe(true);
    const points = r.found ? r.points : [];
    // Up the west side, along the top and down the east: every point on a free square's edge.
    expect(points.every(([x, y]) => x <= 1 || y >= 7 || x >= 7)).toBe(true);
  });
});

/** A chart of unit squares, each `ok`, `marginal` (at risk `r`), or failing; larger boxes fail. */
function costedTree(kind: (x: number, y: number) => "ok" | "fail" | number) {
  const holder: { tree?: QuadTree } = {};
  const session: Session = {
    halfWidth: 0,
    box(sw, ne) {
      const t = holder.tree as QuadTree;
      const [x0, y0] = t.units(sw);
      const [x1, y1] = t.units(ne);
      if (Math.round(x1 - x0) !== 1 || Math.round(y1 - y0) !== 1) {
        return { status: "fail", risk: 1, flags: [] };
      }
      const k = kind(Math.round(x0), Math.round(y0));
      return k === "ok"
        ? { status: "ok", risk: 0, flags: [] }
        : k === "fail"
          ? { status: "fail", risk: 1, flags: [] }
          : { status: "marginal", risk: k, flags: [] };
    },
    segment: () => ({ status: "fail", risk: 1, flags: [] }),
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

/** A path's cost: each piece's length at the weight of the square it lies in. */
function pathCost(tree: QuadTree, points: [number, number][]): number {
  let cost = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1] as [number, number];
    const [bx, by] = points[i] as [number, number];
    const leaf = tree.leafAt((ax + bx) / 2, (ay + by) / 2);
    cost += Math.hypot(bx - ax, by - ay) * strictWeight(leaf as never);
  }
  return cost;
}

describe("lazy A* with marginal squares", () => {
  test("a marginal square is not entered when its flags close it", () => {
    const leaf = (flags: string[]) =>
      ({ state: "marginal", verdict: { status: "marginal", risk: 0.01, flags } }) as never;
    expect(strictWeight(leaf([]))).toBeCloseTo(11);
    expect(strictWeight(leaf(["LAND"]))).toBe(Infinity);
    expect(strictWeight(leaf(["ENTRY_PROHIBITED"]))).toBe(Infinity);
  });

  test("property: lazy classification finds as cheap a path as a fully classified tree", async () => {
    const cell = fc.oneof(
      fc.constant("ok" as const),
      fc.constant("fail" as const),
      fc.double({ min: 0.001, max: 0.01, noNaN: true })
    );
    await fc.assert(
      fc.asyncProperty(fc.array(cell, { minLength: 64, maxLength: 64 }), async (cells) => {
        const kind = (x: number, y: number): "ok" | "fail" | number =>
          (x === 0 && y === 0) || (x === 7 && y === 7) ? "ok" : (cells[y * 8 + x] as never);
        const run = async (tree: QuadTree) => {
          const from = tree.leafAt(0.5, 0.5);
          const to = tree.leafAt(7.5, 7.5);
          const r = await aStar(tree, from as never, [0.5, 0.5], to as never, [7.5, 7.5], {
            ...limits,
            weight: strictWeight
          });
          return r.found ? pathCost(tree, r.points) : Infinity;
        };
        const eager = costedTree(kind);
        eager.leaves(() => true);
        const full = await run(eager);
        const lazy = await run(costedTree(kind));
        return lazy <= full * (1 + 1e-9) + 1e-9;
      }),
      { numRuns: 200 }
    );
  });
});
