import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { PlanningApiV1, Reply, Status, Verdict } from "../oracle/contract";
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
}

interface CheckedLeg {
  status: Status;
  length: number;
}

const RANK: Record<Status, number> = { ok: 0, marginal: 1, unverified: 2, fail: 3 };

/** The worst leg status of a checked route. */
export function worstStatus(legs: readonly { status: Status }[]): Status {
  return legs.reduce<Status>((w, l) => (RANK[l.status] > RANK[w] ? l.status : w), "ok");
}

function directOf(v: Verdict): { status: Status; risk: number; flags: string[]; worst?: LonLat } {
  return { status: v.status, risk: v.risk, flags: v.flags, ...(v.worst && { worst: v.worst }) };
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
  const session = await api.session(
    {
      departure: input.departure,
      until: input.departure + window,
      speed: input.speed,
      xteLimit: input.xteLimit,
      probability: input.probability,
      draft: input.draft
    },
    signal,
    (s) => searchRoute(s, input.from, input.to, opts)
  );
  if (!session.ok) {
    return { status: session.status, body: { errors: [session.error] } };
  }
  const found: SearchOutcome = session.value;
  const base = { plannedAt: new Date(now).toISOString(), direct: directOf(found.direct) };
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
  const check = await api.routeCheck(
    {
      route: { type: "LineString", coordinates: found.coordinates },
      departure: new Date(input.departure).toISOString(),
      speed: input.speed,
      ...(input.xteLimit !== undefined && { xteLimit: input.xteLimit }),
      ...(input.probability !== undefined && { probability: input.probability }),
      ...(input.draft !== undefined && { vessel: { draft: input.draft } })
    },
    signal
  );
  if (check.status !== 200) {
    return check;
  }
  const legs = (check.body as { legs: CheckedLeg[] }).legs;
  return {
    status: 200,
    body: {
      ...base,
      route: { type: "LineString", coordinates: found.coordinates },
      length: legs.reduce((s, l) => s + l.length, 0),
      status: worstStatus(legs),
      check: check.body,
      squares: found.squares,
      work: found.work
    }
  };
}
