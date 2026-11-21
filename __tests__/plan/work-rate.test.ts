import { budgetText, WorkRate } from "../../src/plan/work-rate";

/** The work rate this machine measures from its own plans (plan §6): it reports, never decides. */

describe("WorkRate", () => {
  test("nothing is known before a plan of some size has been measured", () => {
    const r = new WorkRate();
    r.record(50_000, 100);
    r.record(undefined, 100);
    r.record(500_000, 0);
    expect(r.unitsPerSecond()).toBeUndefined();
    expect(r.secondsFor(1_200_000)).toBeUndefined();
    expect(r.plans).toBe(0);
  });

  test("the rate is the plans' work over their time, the latest weighing most", () => {
    const r = new WorkRate();
    r.record(1_000_000, 2000);
    expect(r.unitsPerSecond()).toBeCloseTo(500_000);
    expect(r.secondsFor(1_200_000)).toBeCloseTo(2.4);
    r.record(1_000_000, 1000);
    // (0.8 · 1e6 + 1e6) / (0.8 · 2 s + 1 s): nearer the newer plan's 1e6 a second.
    expect(r.unitsPerSecond()).toBeCloseTo(1.8e6 / 2.6);
    expect(r.plans).toBe(2);
  });
});

describe("budgetText", () => {
  test("the budget, and what it takes here once measured", () => {
    expect(budgetText(1_200_000, undefined)).toBe("1.2 M work units");
    expect(budgetText(1_200_000, 2.84)).toBe("1.2 M work units ≈ 2.8 s here");
    expect(budgetText(25_000_000, 61.4)).toBe("25.0 M work units ≈ 61 s here");
  });
});
