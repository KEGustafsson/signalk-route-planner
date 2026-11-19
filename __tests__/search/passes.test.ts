import { ACCEPTABLE_FLAGS, OK_ONLY, passes } from "../../src/search/passes";

/** Which verdicts the search plans through (AGENTS.md invariant 2). */

const RULE = { accept: ["NOT_FOR_NAVIGATION"], probability: 0.01 };
const v = (status: "ok" | "marginal" | "fail" | "unverified", flags: string[], risk = 0) => ({
  status,
  flags,
  risk
});

describe("pass rule", () => {
  test("ok always passes; nothing else passes without an accepted flag", () => {
    expect(passes(v("ok", []), OK_ONLY)).toBe(true);
    expect(passes(v("unverified", ["NOT_FOR_NAVIGATION"]), OK_ONLY)).toBe(false);
    expect(passes(v("marginal", []), RULE)).toBe(false);
    expect(passes(v("fail", ["NOT_FOR_NAVIGATION"], 0.9), RULE)).toBe(false);
  });

  test("unverified passes only when every flag is accepted and the risk is below the threshold", () => {
    expect(passes(v("unverified", ["NOT_FOR_NAVIGATION"]), RULE)).toBe(true);
    expect(passes(v("unverified", ["NOT_FOR_NAVIGATION", "NO_COVERAGE"]), RULE)).toBe(false);
    expect(passes(v("unverified", ["UNASSESSED"]), RULE)).toBe(false);
    expect(passes(v("unverified", []), RULE)).toBe(false);
    expect(passes(v("unverified", ["NOT_FOR_NAVIGATION"], 0.01), RULE)).toBe(false);
  });

  test("a request may accept only data marked not for navigation", () => {
    expect(ACCEPTABLE_FLAGS).toEqual(["NOT_FOR_NAVIGATION"]);
  });
});
