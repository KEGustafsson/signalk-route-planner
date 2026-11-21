import { DEFAULT_PLAN, limitsFor, withWorkSetting, WORK_SETTING } from "../../src/plan/options";

/**
 * A plan's limits (plan §6): work grows with the trip's straight distance, a corridor's (§4.2)
 * faster, and never falls below the plugin's work setting.
 */

describe("limitsFor", () => {
  test("a short trip in the chart box keeps the default limits", () => {
    expect(limitsFor(DEFAULT_PLAN, 5_000, false)).toBe(DEFAULT_PLAN);
  });

  test("a longer trip in the chart box is given work in proportion to its distance", () => {
    const passage = limitsFor(DEFAULT_PLAN, 37_000, false);
    expect(passage.maxWork).toBe(Math.ceil(37 * DEFAULT_PLAN.workPerKm));
    expect(passage.maxWork).toBeGreaterThan(DEFAULT_PLAN.maxWork);
    expect(passage.maxDistance).toBe(DEFAULT_PLAN.maxDistance);
  });

  test("a corridor's trip: its reach, and work in proportion to it, never less than the default", () => {
    const short = limitsFor(DEFAULT_PLAN, 5_000, true);
    expect(short.maxWork).toBe(DEFAULT_PLAN.maxWork);
    expect(short.maxDistance).toBe(DEFAULT_PLAN.corridorDistance);
    const long = limitsFor(DEFAULT_PLAN, 87_800, true);
    expect(long.maxWork).toBe(Math.ceil(87.8 * DEFAULT_PLAN.corridorWorkPerKm));
    expect(long.maxWork).toBeGreaterThan(DEFAULT_PLAN.maxWork);
  });

  test("a trip past maxDistance keeps the chart box's reach unless it is a corridor's", () => {
    expect(limitsFor(DEFAULT_PLAN, 120_000, false).maxDistance).toBe(DEFAULT_PLAN.maxDistance);
    const far = limitsFor(DEFAULT_PLAN, 120_000, true);
    expect(far.maxDistance).toBe(DEFAULT_PLAN.corridorDistance);
    expect(far.maxWork).toBe(Math.ceil(120 * DEFAULT_PLAN.corridorWorkPerKm));
  });

  test("the work setting is the floor every trip's work grows from", () => {
    const opts = { ...DEFAULT_PLAN, maxWork: 2_500_000 };
    expect(limitsFor(opts, 1_900, false).maxWork).toBe(2_500_000);
    expect(limitsFor(opts, 5_000, true).maxWork).toBe(2_500_000);
  });
});

describe("withWorkSetting", () => {
  test("a whole number of units in range sets the plan's work budget", () => {
    expect(withWorkSetting(DEFAULT_PLAN, 2_500_000)).toEqual({
      opts: { ...DEFAULT_PLAN, maxWork: 2_500_000 }
    });
  });

  test("no setting keeps the default", () => {
    expect(withWorkSetting(DEFAULT_PLAN, undefined).opts).toBe(DEFAULT_PLAN);
  });

  test.each([WORK_SETTING.min - 1, WORK_SETTING.max + 1, 1.5e6 + 0.5, "2000000", Number.NaN])(
    "%p is ignored, with the reason",
    (setting) => {
      const r = withWorkSetting(DEFAULT_PLAN, setting);
      expect(r.opts).toBe(DEFAULT_PLAN);
      expect(r.ignored).toMatch(/work budget must be a whole number/);
    }
  );
});
