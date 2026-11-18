import { parsePlanRequest } from "./api/plan-request";
import type { ApiProvider } from "./api/routes";
import { publicReason } from "./foundation/public-text";
import type { PlanningApiV1, Reply } from "./oracle/contract";
import { planningApi } from "./oracle/contract";
import { plan } from "./plan/plan";

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

export function apiFor(clock: Clock, running: () => AbortSignal | undefined): ApiProvider {
  return {
    status: () => {
      const api = ready();
      return typeof api === "string"
        ? { state: "off", reason: publicReason(api) }
        : { state: "ready", provider: api.provider };
    },
    plan(body: unknown, client: AbortSignal): Promise<Reply> {
      const stop = running();
      if (!stop) {
        return Promise.resolve({ status: 503, body: { errors: ["plugin not started"] } });
      }
      const parsed = parsePlanRequest(body, clock.now());
      if (!parsed.ok) {
        return Promise.resolve({ status: 400, body: { errors: parsed.errors } });
      }
      const api = ready();
      if (typeof api === "string") {
        return Promise.resolve({ status: 503, body: { errors: [api] } });
      }
      const req = parsed.value;
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
          fallback: req.fallback
        },
        AbortSignal.any([client, stop]),
        clock.now()
      );
    }
  };
}
