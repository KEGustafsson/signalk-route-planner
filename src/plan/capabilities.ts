import type { PlanningApiV1, Reply } from "../oracle/contract";

/**
 * The refusal of a request that needs a planning API feature the provider does not serve, if
 * it does: a provider that does not hold legs to bridges (`objects`) would pass them all, so a
 * request with an air height is refused rather than planned blind (AGENTS.md invariant 5).
 */
export function missingFeature(
  api: Pick<PlanningApiV1, "provider" | "features">,
  input: { airHeight?: number }
): Reply | undefined {
  if (input.airHeight === undefined || (api.features ?? []).includes("objects")) {
    return undefined;
  }
  return {
    status: 503,
    body: {
      errors: [
        `${api.provider} does not check bridges and overhead cables; update signalk-underkeel to 0.8.0 or later to plan for an air height`
      ]
    }
  };
}
