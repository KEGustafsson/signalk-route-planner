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
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const YEAR = 365 * 24 * 3_600_000;

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
): { accept?: string[]; fallback?: boolean } {
  const out: { accept?: string[]; fallback?: boolean } = {};
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
  return out;
}

export function parsePlanRequest(body: unknown, now: number): Parsed<PlanRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: ["give from and to as [lon, lat]"] };
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  const from = point(b.from, "from", errors);
  const to = point(b.to, "to", errors);
  let departure: number | undefined;
  if (b.departure !== undefined) {
    const t = typeof b.departure === "string" ? Date.parse(b.departure) : NaN;
    if (!Number.isFinite(t) || Math.abs(t - now) > YEAR) {
      errors.push("departure must be an ISO 8601 time within a year of now");
    } else {
      departure = t;
    }
  }
  const speed = inRange(b, "speed", 0.1, 30, " m/s", errors);
  const xteLimit = inRange(b, "xteLimit", 0, 1000, " m", errors);
  const probability = inRange(b, "probability", 0, 0.5, "", errors, true);
  const draft = inRange(b, "draft", 0.01, 30, " m", errors);
  const { accept, fallback } = searchOptions(b, errors);
  if (errors.length > 0 || !from || !to) {
    return { ok: false, errors };
  }
  const value: PlanRequest = { from, to };
  Object.assign(
    value,
    Object.fromEntries(
      Object.entries({ departure, speed, xteLimit, probability, draft, accept, fallback }).filter(
        ([, v]) => v !== undefined
      )
    )
  );
  return { ok: true, value };
}
