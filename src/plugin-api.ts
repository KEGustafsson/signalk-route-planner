import type { PlanRequest } from "./api/plan-request";
import { parsePlanRequest } from "./api/plan-request";
import type { ApiProvider } from "./api/routes";
import { publicReason } from "./foundation/public-text";
import type { Bbox, PlanningApiV1, Reply } from "./oracle/contract";
import { planningApi } from "./oracle/contract";
import { haversine } from "./foundation/geo";
import type { PlanOptions } from "./plan/options";
import { DEFAULT_PLAN, limitsFor, requestOptions } from "./plan/options";
import type { PlanInput } from "./plan/plan";
import { plan } from "./plan/plan";
import type { Reach } from "./plan/prepare";
import { leavingAtLeast, longTrip, Preparer, searchRegion, tripLimits } from "./plan/prepare";
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
  /** Told why a plan is planned again in a larger region: for the plugin's debug log. */
  note?: (message: string) => void;
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

/** A plan's reply in a few words, for the plugin's debug log. */
function outcome(reply: Reply): string {
  const body = reply.body as { length?: unknown; reason?: unknown } | null;
  return reply.status === 200
    ? `a route of ${String(body?.length)} m`
    : `${String(reply.status)}, ${String(body?.reason)}`;
}

const within = (o: Bbox, i: Bbox): boolean =>
  o[0] <= i[0] && o[1] <= i[1] && o[2] >= i[2] && o[3] >= i[3];

/** Whether the index `now` covers ground the index `before` does not. */
function larger(now: Bbox | undefined, before: Bbox | undefined): boolean {
  return before !== undefined && (now === undefined || !within(before, now));
}

/**
 * Whether a plan made on an index covering `coverage` may be beaten in the whole search region:
 * the index does not hold that region, and the plan is a refusal for want of a way, or a route
 * priced no lower than the least any way leaving the covered region is long (`leavingAtLeast`).
 * With `byLength` false, the search priced its ways by more than their length and narrow
 * water, so any route may be; `narrowWeight` is what each metre of narrows adds to the price.
 */
export function beatable(
  reply: Reply,
  req: PlanRequest,
  coverage: Bbox | undefined,
  byLength = true,
  narrowWeight = 0
): boolean {
  const judged = judgedIn(coverage);
  if (judged === undefined || within(judged, searchRegion(req.from, req.to))) {
    return false;
  }
  const body = reply.body as {
    length?: unknown;
    reason?: unknown;
    fallback?: unknown;
    check?: unknown;
  } | null;
  if (reply.status === 422) {
    // No way through: the way may lie past the region. Any other refusal holds there too.
    return typeof body?.reason === "string" && body.reason.includes(NO_ROUTE_CONNECTS);
  }
  if (reply.status !== 200 || typeof body?.length !== "number") {
    return false;
  }
  // A route's price is at least its length, so a leaving way's length bounds only a price
  // that is length alone: a priced route, a fallback's among them, may lose to a longer way.
  if (!byLength || body.fallback !== undefined) {
    return true;
  }
  return (
    body.length + narrowWeight * narrowsLength(body.length, body.check) >=
    leavingAtLeast(req.from, req.to, judged)
  );
}

/**
 * Metres of the route's narrows legs, the water its price counts `narrowWeight` more on; the
 * whole route when the reply does not say which legs those are.
 */
function narrowsLength(length: number, check: unknown): number {
  const legs = (check as { legs?: unknown } | undefined)?.legs;
  if (!Array.isArray(legs)) {
    return length;
  }
  return (legs as { part?: unknown; length?: unknown }[]).reduce(
    (s, l) => s + (l.part === "narrows" && typeof l.length === "number" ? l.length : 0),
    0
  );
}

/**
 * Whether a plan of `req` prices its ways by their length alone: no risk weight, no preference
 * lines, no alternatives at other risk weights.
 */
export function pricedByLength(opts: PlanOptions, req: PlanRequest): boolean {
  const own = requestOptions(opts, req);
  const lines = own.preferLines && own.preferWeight > 0;
  return own.riskWeight === 0 && !lines && req.alternatives !== true;
}

/** What a metre of narrow water adds to the price of a plan of `req` (`plan/narrows.ts`). */
export function narrowsWeight(opts: PlanOptions, req: PlanRequest): number {
  const own = requestOptions(opts, req);
  return own.narrows ? Math.max(own.narrowWeight, 0) : 0;
}

const pricing = (opts: PlanOptions, req: PlanRequest) => ({
  byLength: pricedByLength(opts, req),
  narrowWeight: narrowsWeight(opts, req)
});

/** The band inside a prepared index's box where it reads no coverage, metres, at most. */
const EDGE_BAND_M = 2000;

/**
 * The ground an index covering `coverage` judges on the charts: its box less the band inside
 * the edge where it reads no coverage (signalk-underkeel builds a region grown by its chart
 * reach, under 2 km). Undefined for an index with no box, which judges everywhere it has charts.
 */
function judgedIn(coverage: Bbox | undefined): Bbox | undefined {
  return coverage && shrunk(coverage, EDGE_BAND_M);
}

/** What the search's refusals for want of a way both say (`NO_WAY`, `UNVERIFIED_WAY`). */
const NO_ROUTE_CONNECTS = "no route the check passes connects the points";

/** `b` less `m` metres on every side; undefined when nothing is left. */
function shrunk(b: Bbox, m: number): Bbox | undefined {
  const dLat = m / 111_195;
  const dLon =
    dLat / Math.max(Math.cos((Math.max(Math.abs(b[1]), Math.abs(b[3])) * Math.PI) / 180), 1e-6);
  const out: Bbox = [b[0] + dLon, b[1] + dLat, b[2] - dLon, b[3] - dLat];
  return out[0] < out[2] && out[1] < out[3] ? out : undefined;
}

/**
 * The plan on `api`, an index for a part of the trip's search region, and while that plan may
 * be beaten past the part (`beatable`): a refusal there for want of a way, or a route one
 * leaving it could be shorter than, planned again in the trip's snug region, then the whole
 * search region, once `wider` has each prepared. An index that holds the snug region already
 * is given again for it, at once, and the whole region is next.
 */
async function widened(
  api: PlanningApiV1,
  req: PlanRequest,
  planOn: (on: PlanningApiV1) => Promise<Reply>,
  wider: (reach: Reach) => Promise<PlanningApiV1 | Reply>,
  pricing: { byLength: boolean; narrowWeight: number },
  note: (message: string) => void = () => undefined
): Promise<Reply> {
  let on = api;
  let reply = await planOn(on);
  for (const reach of ["snug", "whole"] as const) {
    if (!beatable(reply, req, on.coverage(), pricing.byLength, pricing.narrowWeight)) {
      break;
    }
    note(
      `planned in ${JSON.stringify(on.coverage())}: ${outcome(reply)}; asking for the ${reach} region`
    );
    const next = await wider(reach);
    if (!("version" in next)) {
      // Still building (503 with Retry-After), or refused: a region too large for the
      // machine leaves the smaller region's answer standing.
      return next.status === 413 ? reply : next;
    }
    if (larger(next.coverage(), on.coverage())) {
      on = next;
      reply = await planOn(on);
    }
  }
  return reply;
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
    const planOn = async (on: PlanningApiV1): Promise<Reply> => {
      const limits = tripLimits(found, on, dist, opts);
      const d = on.defaults();
      // Timed for the rate alone: the budget is in work units, so the plan is the same anywhere.
      const started = clock.now();
      const reply = await plan(
        on,
        inputOf(req, started, d.speed, hooks.accept?.()),
        AbortSignal.any([client, stop]),
        started,
        limits
      );
      rate.record((reply.body as { work?: unknown } | null)?.work, clock.now() - started);
      hooks.planned?.();
      return reply;
    };
    const wider = (reach: Reach): Promise<PlanningApiV1 | Reply> =>
      preparer.forTrip(found, req.from, req.to, stop, req.draft, reach);
    return near ? widened(api, req, planOn, wider, pricing(opts, req), hooks.note) : planOn(api);
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
