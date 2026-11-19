import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, haversine, midpoint } from "../foundation/geo";
import type { PlanOptions } from "./options";
import { DEFAULT_PLAN } from "./options";
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
 * The least a trip's region reaches past start and destination, metres: the search's least
 * margin and a harbour stage around each end, with their corridors. Asked for when the whole
 * search region is too large to build.
 */
export const PREPARE_MARGIN = 3500;
/** A corridor's reach past the squares and legs the search asks about, metres. */
const CORRIDOR_REACH = 200;
/** A request waits this long for the index before it is answered 503, ms. */
export const PREPARE_WAIT_MS = 20_000;
/** Seconds the 503 asks the client to wait before it plans again. */
export const RETRY_AFTER_S = 30;

const DEG = Math.PI / 180;

/** The box of `points` grown by `margin` metres on every side, within ±85°. */
function around(points: readonly LonLat[], margin: number): Bbox {
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const dLat = margin / (EARTH_RADIUS * DEG);
  const s = Math.max(-85, Math.min(...lats) - dLat);
  const n = Math.min(85, Math.max(...lats) + dLat);
  const dLon = dLat / Math.cos(Math.max(Math.abs(s), Math.abs(n)) * DEG);
  return [Math.min(...lons) - dLon, s, Math.max(...lons) + dLon, n];
}

const union = (a: Bbox, b: Bbox): Bbox => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3])
];

/** The box of `from` and `to` grown by `margin` metres on every side, within ±85°. */
export function tripRegion(from: LonLat, to: LonLat, margin = PREPARE_MARGIN): Bbox {
  return around([from, to], margin);
}

/**
 * Every place the search may ask about: the square its region is cut from, half side
 * d/2 + max(d/2, minMargin) around the midpoint (`shapeFor`), and a harbour stage's region around
 * each end, each with a corridor's reach.
 */
export function searchRegion(from: LonLat, to: LonLat, opts: PlanOptions = DEFAULT_PLAN): Bbox {
  const d = haversine(from, to);
  const half = d / 2 + Math.max(d / 2, opts.minMargin) + CORRIDOR_REACH;
  const harbour = opts.harbourMetres + opts.harbourMargin + CORRIDOR_REACH;
  return union(around([midpoint(from, to)], half), around([from, to], harbour));
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

/**
 * The index for the whole search region, or, when that is too large to build on the machine
 * (413), for the trip's least region: past it the chart reads no coverage, `unverified`, and the
 * search keeps to the water it can check.
 */
async function prepareTrip(
  api: PlanningApiV1 & Required<Pick<PlanningApiV1, "prepare">>,
  whole: Bbox,
  least: Bbox,
  stop: AbortSignal
): Promise<PrepareResult> {
  const r = await api.prepare(holds(least, whole) ? least : whole, stop);
  return !r.ok && r.status === 413 && !holds(least, whole) ? api.prepare(least, stop) : r;
}

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
    // The least the trip needs; the whole search region is asked for first.
    const region = tripRegion(from, to);
    let job = this.inflight;
    if (!job || !holds(job.region, region)) {
      const result = prepareTrip(api, searchRegion(from, to), region, stop).catch(
        (err: Error): PrepareResult => ({ ok: false, status: 503, error: err.message })
      );
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
