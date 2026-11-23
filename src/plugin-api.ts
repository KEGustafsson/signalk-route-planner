import type { PlanRequest } from "./api/plan-request";
import { parsePlanRequest } from "./api/plan-request";
import type { ApiProvider } from "./api/routes";
import { publicReason } from "./foundation/public-text";
import type { PlanningApiV1, Reply } from "./oracle/contract";
import { planningApi } from "./oracle/contract";
import { haversine } from "./foundation/geo";
import type { PlanOptions } from "./plan/options";
import { DEFAULT_PLAN, limitsFor } from "./plan/options";
import type { PlanInput } from "./plan/plan";
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
  /**
   * The flags a plan accepts when its request names none: the plugin's setting for depth data
   * marked not for navigation. A request's own `accept`, even an empty one, is kept.
   */
  accept?: () => string[];
}

/** `GET /status`'s `defaults`: the route-check settings a plan takes unless its request sets them. */
export interface PlanDefaults {
  /** m/s */
  speed: number;
  /** m */
  xteLimit: number;
  /** The accepted P(UKC < 0) of a leg. */
  probability: number;
  /** m: the vessel's draft, as signalk-underkeel takes it, while it states one. */
  draft?: number;
}

/** `GET /status`'s `work`: the budget a plan gets at least, and the plans that measured the rate. */
export interface WorkStatus {
  budget: number;
  plans: number;
  /** Work units a second here, once a plan has been measured. */
  unitsPerSecond?: number;
  /** What the budget takes here, seconds, once a plan has been measured. */
  budgetSeconds?: number;
}

/** The work budget a plan gets at least, and what it takes here once a plan has been measured. */
export function workStatus(opts: PlanOptions, rate: WorkRate): WorkStatus {
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

/** Underkeel's refusal of a session on a planning box it has released since preparing it. */
const RELEASED = "the planning box was released; prepare it again";

/** Whether `reply` is underkeel's refusal of a released planning box. */
export function boxReleased(reply: Reply): boolean {
  const errors = (reply.body as { errors?: unknown } | null)?.errors;
  return reply.status === 503 && Array.isArray(errors) && errors.includes(RELEASED);
}

/** The plan's input from a request, leaving at `started` unless it names a departure. */
function inputOf(
  req: PlanRequest,
  started: number,
  speed: number,
  accept: string[] | undefined
): PlanInput {
  return {
    from: req.from,
    to: req.to,
    departure: req.departure ?? started,
    speed: req.speed ?? speed,
    xteLimit: req.xteLimit,
    probability: req.probability,
    draft: req.draft,
    airHeight: req.airHeight,
    accept: req.accept ?? accept,
    fallback: req.fallback,
    latestDeparture: req.latestDeparture,
    waitEnRoute: req.waitEnRoute,
    waitPoints: req.waitPoints,
    riskWeight: req.riskWeight,
    riskBudget: req.riskBudget,
    alternatives: req.alternatives,
    preferLines: req.preferLines,
    narrows: req.narrows
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
  /** The trip's index prepared, then the plan on it. */
  const planOnce = async (
    found: PlanningApiV1,
    req: PlanRequest,
    stop: AbortSignal,
    client: AbortSignal
  ): Promise<Reply> => {
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
      inputOf(req, started, d.speed, hooks.accept?.()),
      AbortSignal.any([client, stop]),
      started,
      limits
    );
    rate.record((reply.body as { work?: unknown } | null)?.work, clock.now() - started);
    hooks.planned?.();
    return reply;
  };
  return {
    status: () => {
      const api = ready();
      if (typeof api === "string") {
        return { state: "off", reason: publicReason(api) };
      }
      const d = api.defaults();
      const defaults: PlanDefaults = {
        speed: d.speed,
        xteLimit: d.xteLimit,
        probability: d.probability,
        ...(d.draft !== undefined && Number.isFinite(d.draft) && { draft: d.draft })
      };
      return { state: "ready", provider: api.provider, work: workStatus(base(), rate), defaults };
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
      // A planning box underkeel releases between preparing it and a session on it (a build for
      // another trip, or the box around the vessel, replaced it) is prepared again, once.
      let reply = await planOnce(found, req, stop, client);
      if (boxReleased(reply)) {
        reply = await planOnce(found, req, stop, client);
      }
      return reply;
    }
  };
}
