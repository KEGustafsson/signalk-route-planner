import type { LonLat } from "../foundation/geo";
import type { Reply, Status } from "../oracle/contract";
import type { CheckedLeg } from "./proof";

/** A route's risk (plan §4.4), its budget, and the alternatives as a reply lists them. */

/**
 * The route's risk: the chance that some leg has UKC < 0, its legs taken as independent. Summed
 * as logarithms, so a probability far below 1e-16 is kept; a single risky leg's is its own, and
 * the route's is never below its riskiest leg's.
 */
export function routeRisk(legs: readonly { risk: number }[]): number {
  const risky = legs.map((l) => l.risk).filter((p) => p > 0);
  if (risky.length <= 1) {
    return risky[0] ?? 0;
  }
  const all = -Math.expm1(risky.reduce((s, p) => s + Math.log1p(-p), 0));
  return Math.min(1, Math.max(all, ...risky));
}

/** Why a route over the risk budget is not offered, if it is over. */
export function overBudget(
  legs: readonly CheckedLeg[],
  budget: number | undefined
): string | undefined {
  const risk = routeRisk(legs);
  return budget !== undefined && risk > budget
    ? `the route's risk, ${risk.toPrecision(3)}, is over the budget of ${budget}`
    : undefined;
}

/** A refusal's reason, when its body states one. */
export function reasonOf(r: Reply): string {
  const body: unknown = r.body;
  const reason =
    typeof body === "object" && body !== null ? (body as { reason?: unknown }).reason : undefined;
  return typeof reason === "string" ? reason : "the route check does not pass the route";
}

/** `r` with `work` set to the request's total, where its body carries work. */
export function withWork(r: Reply, work: number): Reply {
  const body = r.body as { work?: number };
  return body && typeof body === "object" && "work" in body ? { ...r, body: { ...body, work } } : r;
}

interface Offered {
  route: { coordinates: LonLat[] };
  length: number;
  risk: number;
  status: Status;
  check: { legs: CheckedLeg[] };
  attributions?: unknown[];
}

/**
 * One alternative as the reply lists it: `sameAs` the first earlier one with the same route,
 * else `dominatedBy` the first earlier one no longer and no riskier, so a larger weight that
 * bought no less risk says so. The first offered is never either, and is the one offered.
 */
export function listing(
  name: string,
  riskWeight: number,
  reply: Reply,
  tried: readonly { name: string; reply: Reply }[]
): object {
  if (reply.status !== 200) {
    return { name, riskWeight, reason: reasonOf(reply) };
  }
  const o = reply.body as Offered;
  const key = JSON.stringify(o.route.coordinates);
  const earlier = tried
    .filter((t) => t.name !== name && t.reply.status === 200)
    .map((t) => ({ name: t.name, o: t.reply.body as Offered }));
  const same = earlier.find((t) => JSON.stringify(t.o.route.coordinates) === key);
  const over = same ? undefined : earlier.find((t) => t.o.length <= o.length && t.o.risk <= o.risk);
  return {
    name,
    riskWeight,
    route: o.route,
    length: o.length,
    risk: o.risk,
    status: o.status,
    legs: o.check.legs.map((l) => ({
      status: l.status,
      risk: l.risk,
      length: l.length,
      flags: l.flags
    })),
    ...(o.attributions && { attributions: o.attributions }),
    ...(same && { sameAs: same.name }),
    ...(over && { dominatedBy: over.name })
  };
}
