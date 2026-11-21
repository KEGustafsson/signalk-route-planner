import type { SearchResult } from "../../src/search/astar";
import { cheapest, pathCost } from "../../src/search/anytime";
import type { QuadNode, QuadTree } from "../../src/search/quadtree";

/**
 * The search again at a finer greed (plan §4.1 step 3): its path is kept only when it is
 * clearly cheaper and crosses no more water that is not free.
 */

type XY = [number, number];

/** Free water everywhere, but marginal where y > 5. */
const tree = {
  leafAt: (_x: number, y: number) => ({ state: y > 5 ? "marginal" : "free" }) as QuadNode
} as unknown as QuadTree;

const found = (points: XY[]): SearchResult => ({ found: true, points, expanded: 0 });
const greed = { first: 1.25, fine: 1.05 };

const long: XY[] = [
  [0, 0],
  [50, 4],
  [100, 0]
];
const short: XY[] = [
  [0, 0],
  [100, 0]
];
const shortRisky: XY[] = [
  [0, 0],
  [50, 6],
  [100, 6.1]
];

describe("a finer second search", () => {
  test("a clearly cheaper path through free water replaces the first", async () => {
    const r = await cheapest(tree, (g) => Promise.resolve(found(g === 1.25 ? long : short)), greed);
    expect(r).toEqual(found(short));
  });

  test("a path that crosses more water that is not free does not, however short", async () => {
    expect(pathCost(tree, shortRisky).risky).toBeGreaterThan(pathCost(tree, long).risky);
    const r = await cheapest(
      tree,
      (g) => Promise.resolve(found(g === 1.25 ? long : shortRisky)),
      greed
    );
    expect(r).toEqual(found(long));
  });

  test("a path cheaper by less than a thousandth does not, so the route stays put", async () => {
    const almost: XY[] = [
      [0, 0],
      [50, 3.95],
      [100, 0]
    ];
    const r = await cheapest(
      tree,
      (g) => Promise.resolve(found(g === 1.25 ? long : almost)),
      greed
    );
    expect(r).toEqual(found(long));
  });

  test("out of work, the first path stands; at fine greed already, it is not searched twice", async () => {
    let calls = 0;
    const out = await cheapest(
      tree,
      (g) => {
        calls++;
        return Promise.resolve(
          g === 1.25 ? found(long) : { found: false, reason: "work", expanded: 0 }
        );
      },
      greed
    );
    expect(out).toEqual(found(long));
    calls = 0;
    await cheapest(
      tree,
      () => {
        calls++;
        return Promise.resolve(found(long));
      },
      { first: 1.05, fine: 1.05 }
    );
    expect(calls).toBe(1);
  });
});
