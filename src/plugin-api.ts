import { parsePlanRequest } from "./api/plan-request";
import type { ApiProvider } from "./api/routes";
import { publicReason } from "./foundation/public-text";
import type { PlanningApiV1, Reply } from "./oracle/contract";
import { planningApi } from "./oracle/contract";
import { haversine } from "./foundation/geo";
import { DEFAULT_PLAN, limitsFor } from "./plan/options";
import { plan } from "./plan/plan";
import { longTrip, Preparer, tripLimits } from "./plan/prepare";

/** The REST handlers bound to the planning API signalk-underkeel publishes (plan §5). */

export interface Clock {
  now(): number;
}

export const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

/** Why `/plan` cannot run now, or the planning API to run it on. */
export function ready(): PlanningApiV1 | string {
  const api = planningApi();
  if (typeof api === "string") {
    return api;
  }
  return api.unavailable() ?? api;
}

export function apiFor(
  clock: Clock,
  running: () => AbortSignal | undefined,
  preparer = new Preparer()
): ApiProvider {
  return {
    status: () => {
      const api = ready();
      return typeof api === "string"
        ? { state: "off", reason: publicReason(api) }
        : { state: "ready", provider: api.provider };
    },
    async plan(body: unknown, client: AbortSignal): Promise<Reply> {
      const stop = running();
      if (!stop) {
        return { status: 503, body: { errors: ["plugin not started"] } };
      }
      const parsed = parsePlanRequest(body, clock.now());
      if (!parsed.ok) {
        return { status: 400, body: { errors: parsed.errors } };
      }
      const found = ready();
      if (typeof found === "string") {
        return { status: 503, body: { errors: [found] } };
      }
      const req = parsed.value;
      // A trip plan() refuses (too long, or no distance at all) builds no index.
      const dist = haversine(req.from, req.to);
      // Past maxDistance a trip is planned only where underkeel can survey: in a corridor, or in a
      // planning box where the machine builds its region.
      const reach = limitsFor(DEFAULT_PLAN, dist, longTrip(found, dist)).maxDistance;
      const near = dist >= 1 && dist <= reach;
      // The corridor, if one is needed, is found for the request's draft.
      const api = near ? await preparer.forTrip(found, req.from, req.to, stop, req.draft) : found;
      if (!("version" in api)) {
        return api;
      }
      const limits = tripLimits(found, api, dist);
      const d = api.defaults();
      return plan(
        api,
        {
          from: req.from,
          to: req.to,
          departure: req.departure ?? clock.now(),
          speed: req.speed ?? d.speed,
          xteLimit: req.xteLimit,
          probability: req.probability,
          draft: req.draft,
          accept: req.accept,
          fallback: req.fallback,
          latestDeparture: req.latestDeparture
        },
        AbortSignal.any([client, stop]),
        clock.now(),
        limits
      );
    }
  };
}
