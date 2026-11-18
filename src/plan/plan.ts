import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { PlanningApiV1, Reply, Status, Verdict } from "../oracle/contract";
import { crossable } from "../search/fallback";
import type { PassRule } from "../search/passes";
import { passes } from "../search/passes";
import type { PlanOptions } from "./options";
import { DEFAULT_PLAN } from "./options";
import type { SearchOutcome } from "./search";
import { searchRoute } from "./search";

/**
 * One plan (plan §4.1): the search inside a planning session, then the proof:
 * signalk-underkeel's route check of the route at its departure. The leg
 * statuses in the reply are the route check's (invariant 1).
 */

export interface PlanInput {
  from: LonLat;
  to: LonLat;
  departure: number;
  speed: number;
  xteLimit?: number;
  probability?: number;
  draft?: number;
  /** Flags the search may plan through (`search/passes.ts`); the route stays `unverified`. */
  accept?: readonly string[];
  /** When no route passes, return the lowest risk-weighted route through charted water (`search/fallback.ts`). */
  fallback?: boolean;
}

interface CheckedLeg {
  status: Status;
  length: number;
  risk: number;
  flags: string[];
}

const RANK: Record<Status, number> = { ok: 0, marginal: 1, unverified: 2, fail: 3 };

/** The worst leg status of a checked route. */
export function worstStatus(legs: readonly { status: Status }[]): Status {
  return legs.reduce<Status>((w, l) => (RANK[l.status] > RANK[w] ? l.status : w), "ok");
}

function directOf(v: Verdict): { status: Status; risk: number; flags: string[]; worst?: LonLat } {
  return { status: v.status, risk: v.risk, flags: v.flags, ...(v.worst && { worst: v.worst }) };
}

/** signalk-underkeel's route check of `coordinates` as the request would sail them. */
function prove(
  api: PlanningApiV1,
  input: PlanInput,
  coordinates: LonLat[],
  signal: AbortSignal
): Promise<Reply> {
  return api.routeCheck(
    {
      route: { type: "LineString", coordinates },
      departure: new Date(input.departure).toISOString(),
      speed: input.speed,
      ...(input.xteLimit !== undefined && { xteLimit: input.xteLimit }),
      ...(input.probability !== undefined && { probability: input.probability }),
      ...(input.draft !== undefined && { vessel: { draft: input.draft } })
    },
    signal
  );
}

/** The search in a planning session over the trip's window. */
function search(
  api: PlanningApiV1,
  input: PlanInput,
  window: number,
  signal: AbortSignal,
  opts: PlanOptions,
  rule: PassRule
) {
  return api.session(
    {
      departure: input.departure,
      until: input.departure + window,
      speed: input.speed,
      xteLimit: input.xteLimit,
      probability: input.probability,
      draft: input.draft
    },
    signal,
    (s) => searchRoute(s, input.from, input.to, opts, rule, input.fallback === true)
  );
}

/**
 * Why the proved legs are not offered, if they are not. The search's legs passed over
 * the trip window; the proof checks each at its own arrival. A strict plan is offered
 * only when every leg still passes (or is marginal); a fallback plan is offered with its
 * risky legs marked, as the request asked, but never over water the fallback may not
 * cross (land, no chart, a hard rule).
 */
function refusal(legs: readonly CheckedLeg[], rule: PassRule, strict: boolean): string | undefined {
  const n = legs.filter((l) =>
    strict ? l.status !== "marginal" && !passes(l, rule) : !crossable(l)
  ).length;
  if (n === 0) {
    return undefined;
  }
  return strict
    ? `the route check does not pass ${n} of the ${legs.length} planned legs at the departure`
    : `${n} of the ${legs.length} fallback legs cross water no route may cross at the departure`;
}

export async function plan(
  api: PlanningApiV1,
  input: PlanInput,
  signal: AbortSignal,
  now: number,
  opts: PlanOptions = DEFAULT_PLAN
): Promise<Reply> {
  const d = haversine(input.from, input.to);
  if (d > opts.maxDistance) {
    return {
      status: 400,
      body: { errors: [`from and to are ${Math.round(d)} m apart; at most ${opts.maxDistance} m`] }
    };
  }
  if (d < 1) {
    return { status: 400, body: { errors: ["from and to are the same point"] } };
  }
  const window = Math.ceil(
    Math.max(opts.minWindow, ((opts.windowFactor * d) / input.speed) * 1000)
  );
  const rule: PassRule = {
    accept: input.accept ?? [],
    probability: input.probability ?? api.defaults().probability
  };
  const session = await search(api, input, window, signal, opts, rule);
  if (!session.ok) {
    return { status: session.status, body: { errors: [session.error] } };
  }
  const found: SearchOutcome = session.value;
  const base = {
    plannedAt: new Date(now).toISOString(),
    direct: directOf(found.direct),
    ...(input.accept?.length && { accepted: input.accept })
  };
  if (!found.ok) {
    return {
      status: 422,
      body: {
        ...base,
        reason: found.reason,
        ...(found.unverified > 0 && { unverifiedSquares: found.unverified }),
        work: found.work
      }
    };
  }
  const check = await prove(api, input, found.coordinates, signal);
  if (check.status !== 200) {
    return check;
  }
  const legs = (check.body as { legs: CheckedLeg[] }).legs;
  const refused = refusal(legs, rule, found.fallback === undefined);
  if (refused) {
    return {
      status: 422,
      body: {
        ...base,
        reason: refused,
        check: check.body,
        work: found.work
      }
    };
  }
  return {
    status: 200,
    body: {
      ...base,
      route: { type: "LineString", coordinates: found.coordinates },
      length: legs.reduce((s, l) => s + l.length, 0),
      status: worstStatus(legs),
      check: check.body,
      squares: found.squares,
      work: found.work,
      ...(found.fallback !== undefined && { fallback: found.fallback })
    }
  };
}
