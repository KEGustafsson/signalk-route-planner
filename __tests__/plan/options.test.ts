import { DEFAULT_PLAN, limitsFor } from "../../src/plan/options";

/** A plan's limits (plan §6): a corridor's trip (§4.2) is given work in proportion to it. */

describe("limitsFor", () => {
  test("a trip within maxDistance, not in a corridor, keeps the default limits", () => {
    expect(limitsFor(DEFAULT_PLAN, 20_000, false)).toBe(DEFAULT_PLAN);
  });

  test("a corridor's trip: its reach, and work in proportion to it, never less than the default", () => {
    const short = limitsFor(DEFAULT_PLAN, 5_000, true);
    expect(short.maxWork).toBe(DEFAULT_PLAN.maxWork);
    expect(short.maxDistance).toBe(DEFAULT_PLAN.corridorDistance);
    const long = limitsFor(DEFAULT_PLAN, 87_800, true);
    expect(long.maxWork).toBe(Math.ceil(87.8 * DEFAULT_PLAN.corridorWorkPerKm));
    expect(long.maxWork).toBeGreaterThan(DEFAULT_PLAN.maxWork);
  });

  test("a trip past maxDistance keeps the default limits unless it is a corridor's", () => {
    expect(limitsFor(DEFAULT_PLAN, 120_000, false)).toBe(DEFAULT_PLAN);
    const far = limitsFor(DEFAULT_PLAN, 120_000, true);
    expect(far.maxDistance).toBe(DEFAULT_PLAN.corridorDistance);
    expect(far.maxWork).toBe(Math.ceil(120 * DEFAULT_PLAN.corridorWorkPerKm));
  });
});
