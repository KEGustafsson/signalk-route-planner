import type { LonLat } from "../../src/foundation/geo";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { shapeFor } from "../../src/plan/region";
import type { SearchOutcome } from "../../src/plan/search";
import { searchRoute } from "../../src/plan/search";
import { coarseShape } from "../../src/plan/steer";
import type { Chart, Circle } from "../helpers/synthetic-oracle";
import { at, legStatus, syntheticApi } from "../helpers/synthetic-oracle";

/** Steering (plan §6): a coarse pass first, whose path orders the search. */

const NEVER = new AbortController().signal;

async function search(chart: Chart, from: LonLat, to: LonLat, opts = DEFAULT_PLAN) {
  const r = await syntheticApi(chart).session({ departure: 0, until: 1, speed: 3 }, NEVER, (s) =>
    searchRoute(s, from, to, opts)
  );
  if (!r.ok) {
    throw new Error(r.error);
  }
  return r.value;
}

const passes = (chart: Chart, o: SearchOutcome): boolean =>
  o.ok &&
  o.coordinates
    .slice(1)
    .every((b, i) => legStatus(chart, o.coordinates[i] as LonLat, b, 40) === "ok");

/** A field of islands, 100–600 m across, between a start and a goal 12 km apart. */
function islands(seed: number): Chart {
  let x = seed;
  const r = (): number => (x = (x * 16807) % 2147483647) / 2147483647;
  const obstacles: Circle[] = [];
  for (let i = 0; i < 60; i++) {
    obstacles.push({ x: 1500 + r() * 9000, y: (r() - 0.5) * 6000, r: 100 + r() * 500 });
  }
  return {
    obstacles: obstacles.filter(
      (k) => Math.hypot(k.x, k.y) > k.r + 600 && Math.hypot(k.x - 12000, k.y) > k.r + 600
    )
  };
}

describe("coarse shape", () => {
  test("whole fine squares, no larger than the coarse cell, on the same corners", () => {
    const fine = shapeFor(at(0, 0), at(8000, 0), 20, DEFAULT_PLAN);
    if (typeof fine === "string") {
      throw new Error(fine);
    }
    const coarse = coarseShape(fine, 200);
    if (!coarse) {
      throw new Error("no coarse shape");
    }
    const f = coarse.unit / fine.unit;
    expect(Math.log2(f) % 1).toBe(0);
    expect(coarse.unit).toBeLessThanOrEqual(200);
    expect(coarse.side * f).toBe(fine.side);
    expect([coarse.x0, coarse.y0]).toEqual([fine.x0, fine.y0]);
    // Too small a region to steer: none.
    expect(coarseShape({ ...fine, side: 8 }, 200)).toBeUndefined();
  });
});

describe("steered search", () => {
  const from = at(0, 0);
  const to = at(8000, 0);

  test("through a field of islands, with a fraction of the work of the search that floods it", async () => {
    // One pass: the finer, unguided pass after it spends on a shorter channel what steering saved,
    // when the budget has it (`between.ts`).
    const onePass = { ...DEFAULT_PLAN, greed: 1.05 };
    for (const seed of [1, 2, 3]) {
      const chart = islands(seed);
      const steered = await search(chart, from, at(12000, 0), onePass);
      const flooding = await search(chart, from, at(12000, 0), { ...onePass, steerShare: 0 });
      expect(steered.ok && flooding.ok).toBe(true);
      expect(passes(chart, steered)).toBe(true);
      expect(steered.work).toBeLessThan(flooding.work / 2);
    }
  });

  test("a coarse path through land the fine search cannot follow still finds the way", async () => {
    // A wall of land from far south to just north of the line, one gap 3 km north: the coarse
    // squares along the line hold land, and the way lies far off it.
    const obstacles: Circle[] = [];
    for (let y = -4000; y <= 2500; y += 150) {
      obstacles.push({ x: 4000, y, r: 100 });
    }
    for (let y = 3400; y <= 6000; y += 150) {
      obstacles.push({ x: 4000, y, r: 100 });
    }
    const chart: Chart = { obstacles };
    const o = await search(chart, from, to);
    expect(o.ok).toBe(true);
    expect(passes(chart, o)).toBe(true);
  });
});
