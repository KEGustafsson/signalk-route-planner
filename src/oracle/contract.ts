import type { LonLat } from "../foundation/geo";

/**
 * Planning API v1, served in-process by signalk-underkeel 0.7.0 and later
 * (docs/DEVELOPMENT-PLAN.md §2.1). This copy is the contract this plugin
 * relies on; `planningApi` checks a registered object against it.
 */

export const PLANNING_API = Symbol.for("signalk-underkeel.planning");

export type Status = "ok" | "marginal" | "fail" | "unverified";

export interface Verdict {
  status: Status;
  risk: number;
  flags: string[];
  worst?: LonLat;
}

export interface Window {
  start: number;
  end: number;
}

export interface SessionParams {
  departure: number;
  until: number;
  speed: number;
  xteLimit?: number;
  probability?: number;
  draft?: number;
}

/** What the search asks of the chart: the part of a session it uses. */
export interface Session {
  readonly halfWidth: number;
  box(sw: LonLat, ne: LonLat, window?: Window): Verdict;
  segment(a: LonLat, b: LonLat, window?: Window): Verdict;
  work(): number;
  pause(): Promise<void>;
}

export type SessionResult<T> =
  { ok: true; value: T } | { ok: false; status: number; error: string };

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface PlanningApiV1 {
  readonly version: 1;
  readonly provider: string;
  unavailable(): string | undefined;
  coverage(): [number, number, number, number] | undefined;
  defaults(): { speed: number; xteLimit: number; probability: number; planningBuffer: number };
  session<T>(
    params: SessionParams,
    signal: AbortSignal,
    job: (s: Session) => Promise<T>
  ): Promise<SessionResult<T>>;
  routeCheck(body: unknown, signal: AbortSignal): Promise<Reply>;
}

const METHODS = ["unavailable", "coverage", "defaults", "session", "routeCheck"] as const;

export const NO_API =
  "signalk-underkeel 0.7.0 or later is not running: install and enable it, the planner uses its charts";

/** The registered planning API, or why there is none usable. */
export function planningApi(
  g: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>
): PlanningApiV1 | string {
  const api = g[PLANNING_API] as Partial<PlanningApiV1> | undefined;
  if (api === undefined || api === null) {
    return NO_API;
  }
  if (api.version !== 1) {
    return `signalk-underkeel serves planning API version ${String(api.version)}; this planner needs version 1`;
  }
  const missing = METHODS.filter((m) => typeof api[m] !== "function");
  return missing.length > 0
    ? `signalk-underkeel's planning API lacks ${missing.join(", ")}`
    : (api as PlanningApiV1);
}
