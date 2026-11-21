import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { PlanningApiV1, Reply, Status, Verdict } from "../oracle/contract";
import { berthable, crossable } from "../search/fallback";
import type { PassRule } from "../search/passes";
import { passes } from "../search/passes";
import type { PlanOptions } from "./options";
import { DEFAULT_PLAN, requestOptions } from "./options";
import type { CheckedLeg, Proof } from "./proof";
import { berthsOf, joined, prove } from "./proof";
import type { Part } from "./stages";
import type { Staged } from "./stages";
import { stages } from "./stages";
import { timeDeparture } from "./gate";
import { scheduleWithWaits } from "./waits";
import { listing, overBudget, reasonOf, routeRisk, withWork } from "./risk";
import { missingFeature } from "./capabilities";
import { credited } from "./attribution";

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
  /** The boat's height above the waterline, metres: bridges and overhead cables are held to it. */
  airHeight?: number;
  /** Flags the search may plan through (`search/passes.ts`); the route stays `unverified`. */
  accept?: readonly string[];
  /** When no route passes, return the lowest risk-weighted route through charted water (`search/fallback.ts`). */
  fallback?: boolean;
  /**
   * The latest departure the boat may wait for, epoch ms: when the route passes only at some
   * states of the tide, the plan names the earliest departure up to this that passes (`gate.ts`).
   */
  latestDeparture?: number;
  /**
   * When no single departure up to `latestDeparture` passes, the boat may wait on the way, at
   * places along the route with room to swing (`waits.ts`), as long in all as it may wait to leave.
   */
  waitEnRoute?: boolean;
  /**
   * With `waitEnRoute`: where the boat would rather wait, each reached from the route within
   * `waitReach` (`wait-places.ts`); charted anchorages are such places too.
   */
  waitPoints?: LonLat[];
  /** Keep to leading lines, fairway lines and own tracks (`search/prefer.ts`). */
  preferLines?: boolean;
  /** The risk cost's weight (`PlanOptions.riskWeight`); absent, the plugin's. */
  riskWeight?: number;
  /** The route is offered only while its risk, 1 − Π(1 − P) over its legs, is at most this. */
  riskBudget?: number;
  /** Plan the shortest, balanced and safest routes, and offer the first within the budget. */
  alternatives?: boolean;
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
    arrival: new Date(proof.arrival).toISOString(),
    risk: routeRisk(legs),
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
  /** The options the search ran with: the request's own weights and lines on the plan's. */
  opts: PlanOptions;
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
    draft: input.draft,
    ...(input.airHeight !== undefined && { airHeight: input.airHeight })
  };
  const own = requestOptions(opts, input);
  const { riskWeight } = own;
  const st = { api, params, signal, opts: own, rule, fallback: input.fallback === true };
  const found = await stages(st, input.from, input.to, input.xteLimit);
  if ("error" in found) {
    return {
      reply: { status: found.status, body: { errors: [found.error] } },
      base: {},
      rule,
      work: 0,
      opts: own
    };
  }
  const base = {
    plannedAt: new Date(now).toISOString(),
    riskWeight,
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
    return { reply: { status: 422, body }, base, rule, work: found.work, opts: own };
  }
  const reply = await proved(api, input, signal, { base, rule, found, opts: own });
  return { reply, base, rule, found, work: found.work, opts: own };
}

/** The route check of `found` at `input.departure`, and the reply it makes. */
async function proved(
  api: PlanningApiV1,
  input: PlanInput,
  signal: AbortSignal,
  p: { base: object; rule: PassRule; found: Extract<Staged, { ok: true }>; opts: PlanOptions }
): Promise<Reply> {
  const { base, rule, found } = p;
  const proof = await prove(api, input, found.parts, signal);
  if (!("legs" in proof)) {
    return proof;
  }
  const refused = refusal(proof, found.parts, rule) ?? overBudget(proof.legs, input.riskBudget);
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
  const body = offered(base, found.parts, proof, found);
  return { status: 200, body: await credited(api, input, signal, body, p.opts) };
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
  const note = (reason: string, total = used): Reply =>
    withWork(
      { ...first.reply, body: { ...(first.reply.body as object), gate: { reason } } },
      total
    );
  if (!timed.ok) {
    if (input.waitEnRoute !== true) {
      return note(timed.reason);
    }
    return enRoute(api, input, signal, { opts, first, candidate, used, note });
  }
  // Timed, the parts are held to the strict rule: no leg is left to the fallback.
  const parts = candidate.parts.map(({ fallback: _, ...p }) => p);
  const found = { ...candidate, parts };
  const at = { ...input, departure: timed.departure };
  const r = await proved(api, at, signal, { ...first, found });
  if (r.status !== 200) {
    return note(`leaving at ${new Date(timed.departure).toISOString()}, ${reasonOf(r)}`);
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

/** When no single departure passes: the plan that waits for the water on the way, if any. */
async function enRoute(
  api: PlanningApiV1,
  input: PlanInput & { latestDeparture: number },
  signal: AbortSignal,
  w: {
    opts: PlanOptions;
    first: Planned;
    candidate: Extract<Staged, { ok: true }>;
    used: number;
    note: (reason: string, used: number) => Reply;
  }
): Promise<Reply> {
  const { opts, first, candidate } = w;
  const g = {
    ...input,
    latest: input.latestDeparture,
    swing: opts.waitSwing,
    spacing: opts.waitSpacing,
    reach: opts.waitReach
  };
  const budget = Math.max(0, opts.maxWork - w.used);
  const s = await scheduleWithWaits(api, g, candidate.parts, { rule: first.rule, signal, budget });
  const used = w.used + s.work;
  if (!s.ok && s.stopped === true) {
    // Timing that did not finish answers with its reason alone, never a route.
    return {
      status: 422,
      body: { ...first.base, reason: s.reason, gate: { reason: s.reason }, work: used }
    };
  }
  if (!s.ok) {
    return w.note(s.reason, used);
  }
  return waited(api, input, signal, {
    first,
    candidate,
    used,
    scheduled: s,
    note: (r) => w.note(r, used)
  });
}

/** The plan that waits on the way: its parts proved, each from when the boat leaves for it. */
async function waited(
  api: PlanningApiV1,
  input: PlanInput,
  signal: AbortSignal,
  w: {
    first: Planned;
    candidate: Extract<Staged, { ok: true }>;
    used: number;
    scheduled: Extract<Awaited<ReturnType<typeof scheduleWithWaits>>, { ok: true }>;
    note: (reason: string) => Reply;
  }
): Promise<Reply> {
  const { first, candidate, scheduled: s } = w;
  const parts = s.parts.map(({ fallback: _, ...p }) => p);
  const found = { ...candidate, parts };
  const at = { ...input, departure: s.departure };
  const r = await proved(api, at, signal, { ...first, found });
  const iso = (t: number): string => new Date(t).toISOString();
  if (r.status !== 200) {
    return w.note(`leaving at ${iso(s.departure)} with its waits, ${reasonOf(r)}`);
  }
  const waits = s.waits.map((x) => ({
    at: x.at,
    place: x.place,
    arrive: iso(x.arrive),
    leave: iso(x.leave),
    minutes: Math.round((x.leave - x.arrive) / 60_000)
  }));
  return {
    status: 200,
    body: {
      ...(r.body as object),
      work: w.used,
      departure: iso(s.departure),
      gate: {
        requested: iso(input.departure),
        departure: iso(s.departure),
        waitMinutes: Math.round((s.departure - input.departure) / 60_000),
        legs: s.gated,
        waits
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
  const missing = missingFeature(api, input);
  if (missing) {
    return missing;
  }
  if (input.alternatives === true) {
    return alternatives(api, input, signal, now, opts);
  }
  const first = await planAt(api, input, signal, now, opts);
  const latest = input.latestDeparture;
  if (latest === undefined || latest <= input.departure || passesAsPlanned(first.reply)) {
    return first.reply;
  }
  return gated(api, { ...input, latestDeparture: latest }, signal, now, opts, first);
}

/**
 * The alternatives (plan §4.4): the plan at the shortest, balanced and safest risk weights,
 * each searched and proved on its own. The reply is the first offered within the risk
 * budget, `chosen`, and lists each with its length and risk, or why it is refused. Each is
 * one plan, at the plan's own work limit.
 */
async function alternatives(
  api: PlanningApiV1,
  input: PlanInput,
  signal: AbortSignal,
  now: number,
  opts: PlanOptions
): Promise<Reply> {
  const weights: [string, number][] = [
    ["shortest", 0],
    ["balanced", opts.balancedRisk],
    ["safest", opts.safestRisk]
  ];
  const tried: { name: string; reply: Reply }[] = [];
  const listed: object[] = [];
  let work = 0;
  for (const [name, riskWeight] of weights) {
    const p = await planAt(api, { ...input, riskWeight }, signal, now, opts);
    work += p.work;
    if (p.reply.status !== 200 && p.reply.status !== 422) {
      return p.reply;
    }
    tried.push({ name, reply: p.reply });
    listed.push(listing(name, riskWeight, p.reply, tried));
  }
  const chosen = tried.find((t) => t.reply.status === 200) ?? (tried[0] as (typeof tried)[0]);
  const body = chosen.reply.body as object;
  return {
    status: chosen.reply.status,
    body: {
      ...body,
      work,
      ...(chosen.reply.status === 200 && { chosen: chosen.name }),
      alternatives: listed
    }
  };
}
