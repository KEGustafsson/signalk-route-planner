import type { LonLat } from "../foundation/geo";
import { ACCEPTABLE_FLAGS } from "../search/passes";

/** A `/plan` request, validated (plan §5). */
export interface PlanRequest {
  from: LonLat;
  to: LonLat;
  /** Epoch ms; absent means now. */
  departure?: number;
  /** m/s; absent means signalk-underkeel's route-check speed. */
  speed?: number;
  xteLimit?: number;
  probability?: number;
  draft?: number;
  /** Flags the search may plan through; the route then comes back `unverified`. */
  accept?: string[];
  /** When no route passes, the lowest risk-weighted route through charted water, its legs marked. */
  fallback?: boolean;
  /** Epoch ms: the latest the boat may wait to leave for the tide (`plan/gate.ts`). */
  latestDeparture?: number;
  /** With `latestDeparture`: the boat may wait for the tide on the way too (`plan/waits.ts`). */
  waitEnRoute?: boolean;
  /** The risk cost's weight α: 0 the shortest route, larger keeps farther from the margin. */
  riskWeight?: number;
  /** Offer a route only while 1 − Π(1 − P) over its legs is at most this. */
  riskBudget?: number;
  /** Plan the shortest, balanced and safest routes (`plan/plan.ts`). */
  alternatives?: boolean;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const YEAR = 365 * 24 * 3_600_000;

/** The longest a plan may wait for the tide: a day covers two tides everywhere. */
export const MAX_WAIT_MS = 24 * 3_600_000;

const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Epoch ms of an ISO 8601 date and time with a zone (`Z` or an offset), else NaN. Date.parse
 * alone takes other forms and rolls an impossible date over (30 February becomes March).
 */
export function isoTime(v: string): number {
  const m = ISO_TIME.exec(v);
  if (!m) {
    return NaN;
  }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((x) => Number(x ?? 0)) as number[];
  const days = new Date(Date.UTC(y as number, mo as number, 0)).getUTCDate();
  const valid =
    (mo as number) >= 1 &&
    (mo as number) <= 12 &&
    (d as number) >= 1 &&
    (d as number) <= days &&
    (h as number) < 24 &&
    (mi as number) < 60 &&
    (s as number) < 60;
  return valid ? Date.parse(v) : NaN;
}

/** `departure` and `latestDeparture`, ISO 8601, each checked. */
function times(
  b: Record<string, unknown>,
  now: number,
  errors: string[]
): { departure?: number; latestDeparture?: number } {
  const iso = (v: unknown): number => (typeof v === "string" ? isoTime(v) : NaN);
  let departure: number | undefined;
  if (b.departure !== undefined) {
    const t = iso(b.departure);
    if (!Number.isFinite(t) || Math.abs(t - now) > YEAR) {
      errors.push("departure must be an ISO 8601 time within a year of now");
    } else {
      departure = t;
    }
  }
  if (b.latestDeparture === undefined) {
    return { departure };
  }
  const from = departure ?? now;
  const t = iso(b.latestDeparture);
  if (!Number.isFinite(t) || t < from || t > from + MAX_WAIT_MS) {
    errors.push("latestDeparture must be an ISO 8601 time from the departure to 24 h after it");
    return { departure };
  }
  return { departure, latestDeparture: t };
}

function point(v: unknown, name: string, errors: string[]): LonLat | undefined {
  if (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    v[0] >= -180 &&
    v[0] <= 180 &&
    v[1] >= -85 &&
    v[1] <= 85
  ) {
    return [v[0], v[1]];
  }
  errors.push(`${name} must be [lon, lat] within [-180, 180] × [-85, 85]`);
  return undefined;
}

function inRange(
  body: Record<string, unknown>,
  key: string,
  lo: number,
  hi: number,
  unit: string,
  errors: string[],
  open = false
): number | undefined {
  const v = body[key];
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v > hi || (open ? v <= lo : v < lo)) {
    errors.push(`${key} must be ${open ? "over " : ""}${lo}..${hi}${unit}`);
    return undefined;
  }
  return v;
}

/** The search options `accept` and `fallback`, validated. */
function searchOptions(
  b: Record<string, unknown>,
  errors: string[]
): { accept?: string[]; fallback?: boolean; waitEnRoute?: boolean } {
  const out: { accept?: string[]; fallback?: boolean; waitEnRoute?: boolean } = {};
  if (b.accept !== undefined) {
    const ok = (f: unknown) => (ACCEPTABLE_FLAGS as readonly unknown[]).includes(f);
    if (Array.isArray(b.accept) && b.accept.every(ok)) {
      out.accept = [...new Set(b.accept as string[])];
    } else {
      errors.push(`accept may list only ${ACCEPTABLE_FLAGS.join(", ")}`);
    }
  }
  if (b.fallback !== undefined) {
    if (typeof b.fallback === "boolean") {
      out.fallback = b.fallback;
    } else {
      errors.push("fallback must be true or false");
    }
  }
  if (b.waitEnRoute !== undefined) {
    if (typeof b.waitEnRoute !== "boolean") {
      errors.push("waitEnRoute must be true or false");
    } else if (b.waitEnRoute && b.latestDeparture === undefined) {
      errors.push("waitEnRoute needs latestDeparture: the boat waits at most until then in all");
    } else {
      out.waitEnRoute = b.waitEnRoute;
    }
  }
  return out;
}

/** The risk options, validated: `riskWeight`, `riskBudget` and `alternatives`. */
function riskOptions(
  b: Record<string, unknown>,
  errors: string[]
): { riskWeight?: number; riskBudget?: number; alternatives?: boolean } {
  const riskWeight = inRange(b, "riskWeight", 0, 100, "", errors);
  const riskBudget = inRange(b, "riskBudget", 0, 1, "", errors, true);
  if (b.alternatives === undefined) {
    return { riskWeight, riskBudget };
  }
  if (typeof b.alternatives !== "boolean") {
    errors.push("alternatives must be true or false");
  } else if (b.alternatives && b.riskWeight !== undefined) {
    errors.push("alternatives set their own riskWeight: give one or the other");
  } else if (b.alternatives && b.latestDeparture !== undefined) {
    errors.push("alternatives are planned at one departure: not with latestDeparture");
  } else {
    return { riskWeight, riskBudget, alternatives: b.alternatives };
  }
  return { riskWeight, riskBudget };
}

export function parsePlanRequest(body: unknown, now: number): Parsed<PlanRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: ["give from and to as [lon, lat]"] };
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  const from = point(b.from, "from", errors);
  const to = point(b.to, "to", errors);
  const { departure, latestDeparture } = times(b, now, errors);
  const speed = inRange(b, "speed", 0.1, 30, " m/s", errors);
  const xteLimit = inRange(b, "xteLimit", 0, 1000, " m", errors);
  const probability = inRange(b, "probability", 0, 0.5, "", errors, true);
  const draft = inRange(b, "draft", 0.01, 30, " m", errors);
  const { accept, fallback, waitEnRoute } = searchOptions(b, errors);
  const { riskWeight, riskBudget, alternatives } = riskOptions(b, errors);
  if (errors.length > 0 || !from || !to) {
    return { ok: false, errors };
  }
  const value: PlanRequest = { from, to };
  Object.assign(
    value,
    Object.fromEntries(
      Object.entries({
        departure,
        latestDeparture,
        speed,
        xteLimit,
        probability,
        draft,
        accept,
        fallback,
        waitEnRoute,
        riskWeight,
        riskBudget,
        alternatives
      }).filter(([, v]) => v !== undefined)
    )
  );
  return { ok: true, value };
}
