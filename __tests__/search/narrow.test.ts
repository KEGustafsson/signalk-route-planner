import fc from "fast-check";
import type { LonLat } from "../../src/foundation/geo";
import type { Narrow } from "../../src/search/narrow";
import { inside, narrowShare } from "../../src/search/narrow";
import type { QuadNode, QuadTree } from "../../src/search/quadtree";

/** The length of a leg inside a square (`search/narrow.ts`), by which a shortcut is priced. */

const square = { x: 0, y: 0, size: 10 };

describe("a leg's length inside a square", () => {
  test("through, along an edge's line inside, and past it", () => {
    expect(inside(square, [-5, 5], [15, 5])).toBeCloseTo(10);
    expect(inside(square, [2, 2], [8, 8])).toBeCloseTo(Math.hypot(6, 6));
    expect(inside(square, [-5, -5], [15, 15])).toBeCloseTo(Math.hypot(10, 10));
    expect(inside(square, [-5, 12], [15, 12])).toBe(0);
    expect(inside(square, [5, 5], [5, 5])).toBe(0);
  });

  test("the parts in four squares that tile a larger one add up to the leg", () => {
    const quads = [
      { x: 0, y: 0, size: 5 },
      { x: 5, y: 0, size: 5 },
      { x: 0, y: 5, size: 5 },
      { x: 5, y: 5, size: 5 }
    ];
    const point = fc.tuple(
      fc.double({ min: 0, max: 10, noNaN: true }),
      fc.double({ min: 0, max: 10, noNaN: true })
    );
    fc.assert(
      fc.property(point, point, (a, b) => {
        const sum = quads.reduce((s, q) => s + inside(q, a, b), 0);
        return Math.abs(sum - Math.hypot(b[0] - a[0], b[1] - a[1])) < 1e-6;
      })
    );
  });
});

describe("a leg's share in narrow water", () => {
  // Two narrow squares west of x = 10, two wide ones east of it, meeting along y = 10.
  const leaves: QuadNode[] = [
    { id: 1, x: 0, y: 0, size: 10, state: "free" },
    { id: 2, x: 0, y: 10, size: 10, state: "free" },
    { id: 3, x: 10, y: 0, size: 10, state: "free" },
    { id: 4, x: 10, y: 10, size: 10, state: "free" }
  ];
  const tree = {
    units: (p: LonLat): [number, number] => [p[0], p[1]],
    leaves: (touches: (n: QuadNode) => boolean) => leaves.filter(touches)
  } as unknown as QuadTree;
  const nar: Narrow = { weight: 1, margin: 20, wide: (n) => n.x >= 10, fairway: () => false };

  test("a leg along the edge two narrow squares share counts that stretch once", () => {
    expect(narrowShare(nar, tree, [0, 10], [20, 10])).toBeCloseTo(0.5);
  });

  test("a leg across the squares, and one of no length, as before", () => {
    expect(narrowShare(nar, tree, [0, 5], [20, 5])).toBeCloseTo(0.5);
    expect(narrowShare(nar, tree, [0, 5], [10, 15])).toBeCloseTo(1);
    expect(narrowShare(nar, tree, [5, 5], [5, 5])).toBe(0);
  });
});
