import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { PlanningApiV1, Reply, Status, Verdict } from "../oracle/contract";
import { berthable, crossable } from "../search/fallback";
import type { PassRule } from "../search/passes";
import { passes } from "../search/passes";
import type { PlanOptions } from "./options";
import { DEFAULT_PLAN } from "./options";
import type { CheckedLeg, Proof } from "./proof";
import { joined, prove } from "./proof";
import type { Part } from "./stages";
import type { Staged } from "./stages";
import { stages } from "./stages";
import { timeDeparture } from "./gate";

/**
 * One plan (plan §4.1): the search in planning sessions (`stages.ts`), then the proof:
 * signalk-underkeel's route check of each part at its departure (`proof.ts`). The leg
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
  /**
   * The latest departure the boat may wait for, epoch ms: when the route passes only at some
   * states of the tide, the plan names the earliest departure up to this that passes (`gate.ts`).
   */
  latestDeparture?: number;
}

const RANK: Record<Status, number> = { ok: 0, marginal: 1, unverified: 2, fail: 3 };

/** The worst leg status of a checked route. */
export function worstStatus(legs: readonly { status: Status }[]): Status {
  return legs.reduce<Status>((w, l) => (RANK[l.status] > RANK[w] ? l.status : w), "ok");
}

function directOf(v: Verdict): { status: Status; risk: number; flags: string[]; worst?: LonLat } {
  return { status: v.status, risk: v.risk, flags: v.flags, ...(v.worst && { worst: v.worst }) };
}

/**
 * Why the proved legs are not offered, if they are not. The search's legs passed over the
 * trip window; the proof checks each at its own arrival. A part searched without
 * `fallback` is offered only when every leg still passes (or is marginal); a fallback
 * part is offered with its risky legs marked, as the request asked, but never over water
 * the fallback may not cross (land, no chart, a hard rule). A berth leg touches its quay
 * by design, so its `LAND` is not counted, but a berth leg a hard rule or no chart closes is.
 */
function refusal(proof: Proof, parts: readonly Part[], rule: PassRule): string | undefined {
  let strict = 0;
  let closed = proof.legs.filter((l) => l.berth && !berthable(l)).length;
  proof.parts.forEach((span, k) => {
    const own = proof.legs.slice(span.legs[0], span.legs[1] + 1).filter((l) => !l.berth);
    if (parts[k]?.fallback === undefined) {
      strict += own.filter(
        (l) => !(l.status === "marginal" && crossable(l)) && !passes(l, rule)
      ).length;
    } else {
      closed += own.filter((l) => !crossable(l)).length;
    }
  });
  const n = proof.legs.length;
  if (strict > 0) {
    return `the route check does not pass ${strict} of the ${n} planned legs at the departure`;
  }
  return closed > 0
    ? `${closed} of the ${n} planned legs cross water no route may cross at the departure`
    : undefined;
}

function berthsOf(legs: readonly CheckedLeg[]) {
  return legs
    .filter((l) => l.berth)
    .map((l) => ({ end: l.index === 0 ? "start" : "end", leg: l.index, length: l.length }));
}

/** The 200 reply: the route, its legs as the route check gave them, and how it was found. */
function offered(
  base: object,
  parts: readonly Part[],
  proof: Proof,
  found: { squares: number; work: number }
) {
  const legs = proof.legs;
  const berths = berthsOf(legs);
  const fallback = parts.find((p) => p.fallback !== undefined)?.fallback;
  return {
    ...base,
    route: { type: "LineString", coordinates: joined(parts) },
    length: legs.reduce((s, l) => s + l.length, 0),
    status: worstStatus(legs),
    ...(berths.length > 0 && { underway: worstStatus(legs.filter((l) => !l.berth)), berths }),
    check: { ...proof.first, legs, parts: proof.parts },
    squares: found.squares,
    work: found.work,
    ...(fallback !== undefined && { fallback })
  };
}

/** One plan at `input.departure`, its verdicts holding for departures up to `latest`. */
interface Planned {
  reply: Reply;
  base: object;
  rule: PassRule;
  found?: Extract<Staged, { ok: true }>;
  /** The planning API work its search did, offered or refused. */
  work: number;
}

async function planAt(
  api: PlanningApiV1,
  input: PlanInput,
  signal: AbortSignal,
  now: number,
  opts: PlanOptions
): Promise<Planned> {
  const d = haversine(input.from, input.to);
  const window = Math.ceil(
    Math.max(opts.minWindow, ((opts.windowFactor * d) / input.speed) * 1000)
  );
  const rule: PassRule = {
    accept: input.accept ?? [],
    probability: input.probability ?? api.defaults().probability
  };
  const params = {
    departure: input.departure,
    // Every departure the boat may wait for, and the trip after the last of them.
    until: Math.max(input.departure, input.latestDeparture ?? input.departure) + window,
    speed: input.speed,
    xteLimit: input.xteLimit,
    probability: input.probability,
    draft: input.draft
  };
  const st = { api, params, signal, opts, rule, fallback: input.fallback === true };
  const found = await stages(st, input.from, input.to, input.xteLimit);
  if ("error" in found) {
    return {
      reply: { status: found.status, body: { errors: [found.error] } },
      base: {},
      rule,
      work: 0
    };
  }
  const base = {
    plannedAt: new Date(now).toISOString(),
    direct: directOf(found.direct),
    ...(input.accept?.length && { accepted: input.accept })
  };
  if (!found.ok) {
    const r = found.refusal;
    const body = {
      ...base,
      reason: r.reason,
      ...(r.unverified > 0 && { unverifiedSquares: r.unverified }),
      work: found.work
    };
    return { reply: { status: 422, body }, base, rule, work: found.work };
  }
  const reply = await proved(api, input, signal, { base, rule, found });
  return { reply, base, rule, found, work: found.work };
}

/** The route check of `found` at `input.departure`, and the reply it makes. */
async function proved(
  api: PlanningApiV1,
  input: PlanInput,
  signal: AbortSignal,
  p: { base: object; rule: PassRule; found: Extract<Staged, { ok: true }> }
): Promise<Reply> {
  const { base, rule, found } = p;
  const proof = await prove(api, input, found.parts, signal);
  if (!("legs" in proof)) {
    return proof;
  }
  const refused = refusal(proof, found.parts, rule);
  if (refused) {
    return {
      status: 422,
      body: {
        ...base,
        reason: refused,
        check: { ...proof.first, legs: proof.legs, parts: proof.parts },
        work: found.work
      }
    };
  }
  return { status: 200, body: offered(base, found.parts, proof, found) };
}

/** `r` with `work` set to the request's total, where its body carries work. */
function withWork(r: Reply, work: number): Reply {
  const body = r.body as { work?: number };
  return body && typeof body === "object" && "work" in body ? { ...r, body: { ...body, work } } : r;
}

/** True when a reply offers a route that passes as planned, with no leg left to the tide. */
const passesAsPlanned = (r: Reply): boolean =>
  r.status === 200 && (r.body as { fallback?: string }).fallback === undefined;

/**
 * The tide gate (plan §4.3): the plan, or the fallback's route when none passes, timed to the
 * earliest departure up to `latestDeparture` at which the route check passes every leg.
 */
async function gated(
  api: PlanningApiV1,
  input: PlanInput & { latestDeparture: number },
  signal: AbortSignal,
  now: number,
  opts: PlanOptions,
  first: Planned
): Promise<Reply> {
  // One budget for the whole request: the first search, the fallback's, and the timing.
  let used = first.work;
  let candidate = first.found;
  if (!candidate) {
    const left = opts.maxWork - used;
    if (left <= 0) {
      return first.reply;
    }
    const again = await planAt(api, { ...input, fallback: true }, signal, now, {
      ...opts,
      maxWork: left
    });
    used += again.work;
    candidate = again.found;
  }
  if (!candidate) {
    return withWork(first.reply, used);
  }
  const g = { ...input, latest: input.latestDeparture };
  const budget = Math.max(0, opts.maxWork - used);
  const timed = await timeDeparture(api, g, candidate.parts, { rule: first.rule, signal, budget });
  used += timed.work;
  const note = (reason: string): Reply =>
    withWork({ ...first.reply, body: { ...(first.reply.body as object), gate: { reason } } }, used);
  if (!timed.ok) {
    return note(timed.reason);
  }
  // Timed, the parts are held to the strict rule: no leg is left to the fallback.
  const parts = candidate.parts.map(({ fallback: _, ...p }) => p);
  const found = { ...candidate, parts };
  const at = { ...input, departure: timed.departure };
  const r = await proved(api, at, signal, { base: first.base, rule: first.rule, found });
  if (r.status !== 200) {
    return note(
      `the route check does not pass the route leaving at ${new Date(timed.departure).toISOString()}`
    );
  }
  const body = r.body as object;
  return {
    status: 200,
    body: {
      ...body,
      // Every search and the timing, each counted once.
      work: used,
      departure: new Date(timed.departure).toISOString(),
      gate: {
        requested: new Date(input.departure).toISOString(),
        departure: new Date(timed.departure).toISOString(),
        waitMinutes: Math.round((timed.departure - input.departure) / 60_000),
        legs: timed.gated
      }
    }
  };
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
  const first = await planAt(api, input, signal, now, opts);
  const latest = input.latestDeparture;
  if (latest === undefined || latest <= input.departure || passesAsPlanned(first.reply)) {
    return first.reply;
  }
  return gated(api, { ...input, latestDeparture: latest }, signal, now, opts, first);
}
