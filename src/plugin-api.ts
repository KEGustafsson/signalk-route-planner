import { parsePlanRequest } from "./api/plan-request";
import type { ApiProvider } from "./api/routes";
import { publicReason } from "./foundation/public-text";
import type { PlanningApiV1, Reply } from "./oracle/contract";
import { planningApi } from "./oracle/contract";
import { haversine } from "./foundation/geo";
import type { PlanOptions } from "./plan/options";
import { DEFAULT_PLAN, limitsFor } from "./plan/options";
import { plan } from "./plan/plan";
import { longTrip, Preparer, tripLimits } from "./plan/prepare";
import { WorkRate } from "./plan/work-rate";

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

/** What the plugin gives `/plan` besides the planning API: its settings, and where to measure. */
export interface PlanHooks {
  /** The plan options the plugin's settings give, the work budget among them. */
  limits?: () => PlanOptions;
  /** Where each plan's work and time is recorded (`plan/work-rate.ts`). */
  rate?: WorkRate;
  /** After a plan has been recorded. */
  planned?: () => void;
}

/** The work budget a plan gets at least, and what it takes here once a plan has been measured. */
export function workStatus(opts: PlanOptions, rate: WorkRate) {
  const perSecond = rate.unitsPerSecond();
  return {
    budget: opts.maxWork,
    plans: rate.plans,
    ...(perSecond !== undefined && {
      unitsPerSecond: Math.round(perSecond),
      budgetSeconds: Math.round((opts.maxWork / perSecond) * 10) / 10
    })
  };
}

export function apiFor(
  clock: Clock,
  running: () => AbortSignal | undefined,
  preparer = new Preparer(),
  hooks: PlanHooks = {}
): ApiProvider {
  const base = hooks.limits ?? (() => DEFAULT_PLAN);
  const rate = hooks.rate ?? new WorkRate();
  return {
    status: () => {
      const api = ready();
      return typeof api === "string"
        ? { state: "off", reason: publicReason(api) }
        : { state: "ready", provider: api.provider, work: workStatus(base(), rate) };
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
      const opts = base();
      const reach = limitsFor(opts, dist, longTrip(found, dist, opts)).maxDistance;
      const near = dist >= 1 && dist <= reach;
      // The corridor, if one is needed, is found for the request's draft.
      const api = near ? await preparer.forTrip(found, req.from, req.to, stop, req.draft) : found;
      if (!("version" in api)) {
        return api;
      }
      const limits = tripLimits(found, api, dist, opts);
      const d = api.defaults();
      // Timed for the rate alone: the budget is in work units, so the plan is the same anywhere.
      const started = clock.now();
      const reply = await plan(
        api,
        {
          from: req.from,
          to: req.to,
          departure: req.departure ?? started,
          speed: req.speed ?? d.speed,
          xteLimit: req.xteLimit,
          probability: req.probability,
          draft: req.draft,
          airHeight: req.airHeight,
          accept: req.accept,
          fallback: req.fallback,
          latestDeparture: req.latestDeparture,
          waitEnRoute: req.waitEnRoute,
          waitPoints: req.waitPoints,
          riskWeight: req.riskWeight,
          riskBudget: req.riskBudget,
          alternatives: req.alternatives,
          preferLines: req.preferLines
        },
        AbortSignal.any([client, stop]),
        started,
        limits
      );
      rate.record((reply.body as { work?: unknown } | null)?.work, clock.now() - started);
      hooks.planned?.();
      return reply;
    }
  };
}
