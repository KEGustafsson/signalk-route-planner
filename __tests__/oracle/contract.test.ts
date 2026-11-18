import { NO_API, PLANNING_API, planningApi } from "../../src/oracle/contract";
import { syntheticApi } from "../helpers/synthetic-oracle";

/** The planning API registered by signalk-underkeel is used only when it is version 1 and whole. */

describe("planning API lookup", () => {
  test("absent: the reason names signalk-underkeel", () => {
    expect(planningApi({})).toBe(NO_API);
  });

  test("another version, or a method missing, is refused with the reason", () => {
    expect(planningApi({ [PLANNING_API]: { version: 2 } })).toMatch(
      /version 2; this planner needs version 1/
    );
    const partial = { ...syntheticApi({ obstacles: [] }), routeCheck: undefined };
    expect(planningApi({ [PLANNING_API]: partial })).toMatch(/lacks routeCheck/);
  });

  test("a whole version 1 API is returned as it is", () => {
    const api = syntheticApi({ obstacles: [] });
    expect(planningApi({ [PLANNING_API]: api })).toBe(api);
  });

  test("the symbol is the one signalk-underkeel registers", () => {
    expect(PLANNING_API).toBe(Symbol.for("signalk-underkeel.planning"));
  });
});
