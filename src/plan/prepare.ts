import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS } from "../foundation/geo";
import type { Bbox, PlanningApiV1, Prepared, PrepareResult, Reply } from "../oracle/contract";
import { canPrepare } from "../oracle/contract";

/**
 * Charts for a trip past the chart box around the vessel (plan §4.2, R2): signalk-underkeel's
 * `prepare` gives an index for the trip's region, the chart box when it covers it, else a
 * planning box it builds. A build can take minutes on a Raspberry Pi, longer than a request
 * should be held, so `/plan` waits a little for it and otherwise answers 503 with Retry-After
 * while the build runs on; asked again, it plans on the built index.
 */

/**
 * The trip's region reaches past start and destination by this, metres: the search's margin
 * and a harbour stage around each end, with their corridors.
 */
export const PREPARE_MARGIN = 3500;
/** A request waits this long for the index before it is answered 503, ms. */
export const PREPARE_WAIT_MS = 20_000;
/** Seconds the 503 asks the client to wait before it plans again. */
export const RETRY_AFTER_S = 30;

const DEG = Math.PI / 180;

/** The box of `from` and `to` grown by `margin` metres on every side, within ±85°. */
export function tripRegion(from: LonLat, to: LonLat, margin = PREPARE_MARGIN): Bbox {
  const dLat = margin / (EARTH_RADIUS * DEG);
  const s = Math.max(-85, Math.min(from[1], to[1]) - dLat);
  const n = Math.min(85, Math.max(from[1], to[1]) + dLat);
  const dLon = dLat / Math.cos(Math.max(Math.abs(s), Math.abs(n)) * DEG);
  return [Math.min(from[0], to[0]) - dLon, s, Math.max(from[0], to[0]) + dLon, n];
}

const holds = (o: Bbox, i: Bbox): boolean =>
  o[0] <= i[0] && o[1] <= i[1] && o[2] >= i[2] && o[3] >= i[3];

/** `api` with its session and route check over the prepared index `p`. */
export function onPrepared(api: PlanningApiV1, p: Prepared): PlanningApiV1 {
  return {
    version: 1,
    provider: api.provider,
    unavailable: () => api.unavailable(),
    coverage: () => p.coverage,
    defaults: () => api.defaults(),
    session: (params, signal, job) => p.session(params, signal, job),
    routeCheck: (body, signal) => p.routeCheck(body, signal)
  };
}

/** The 503 while the trip's index is built. */
export const BUILDING: Reply = {
  status: 503,
  headers: { "Retry-After": String(RETRY_AFTER_S) },
  body: {
    errors: [
      "signalk-underkeel is building the chart index for this trip's region, past the chart box around the vessel; plan again shortly"
    ],
    preparing: true
  }
};

const sleep = (ms: number): Promise<"waiting"> =>
  new Promise((resolve) => setTimeout(() => resolve("waiting"), ms).unref?.());

/** One trip's index at a time asked for, the build carried on past the request that asked. */
export class Preparer {
  private inflight: { region: Bbox; result: Promise<PrepareResult> } | undefined;

  constructor(private readonly waitMs = PREPARE_WAIT_MS) {}

  /**
   * The planning API over an index for the trip `from`–`to`; `api` itself when it serves no
   * `prepare`; BUILDING while the index is still being built after `waitMs`; the provider's
   * refusal as a reply. The build runs until `stop` (the plugin stopping), not the request.
   */
  async forTrip(
    api: PlanningApiV1,
    from: LonLat,
    to: LonLat,
    stop: AbortSignal
  ): Promise<PlanningApiV1 | Reply> {
    if (!canPrepare(api)) {
      return api;
    }
    const region = tripRegion(from, to);
    let job = this.inflight;
    if (!job || !holds(job.region, region)) {
      const result = api
        .prepare(region, stop)
        .catch((err: Error): PrepareResult => ({ ok: false, status: 503, error: err.message }));
      job = { region, result };
      this.inflight = job;
      const mine = job;
      void result.finally(() => {
        if (this.inflight === mine) {
          this.inflight = undefined;
        }
      });
    }
    const r = await Promise.race([job.result, sleep(this.waitMs)]);
    if (r === "waiting") {
      return BUILDING;
    }
    if (!r.ok) {
      return { status: r.status, body: { errors: [r.error] } };
    }
    return onPrepared(api, r.value);
  }
}
