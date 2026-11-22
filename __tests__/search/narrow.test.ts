import fc from "fast-check";
import { inside } from "../../src/search/narrow";

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
