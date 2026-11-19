import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, haversine, midpoint } from "../foundation/geo";
import type { PlanOptions } from "./options";
import { DEFAULT_PLAN } from "./options";
import type { Bbox, PlanningApiV1, Prepared, PrepareResult, Reply } from "../oracle/contract";
import { canPrepare, canSurvey } from "../oracle/contract";
import { boxOf, corridorFor, SURVEY_CELL, surveyRegion } from "./corridor";

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
 * A build asked of the provider: the region it is building now, undefined for a corridor, the
 * trip it is for, its result, and `narrowed`, settled when a 413 turned it to a smaller region
 * (each time a fresh one).
 */
interface Build {
  region: Bbox | undefined;
  readonly trip: string;
  result: Promise<PrepareResult>;
  narrowed: Promise<"narrowed">;
}

type Preparing = PlanningApiV1 & Required<Pick<PlanningApiV1, "prepare">>;

/** The draft the corridor is found for when the request gives none, metres. */
export const COARSE_DRAFT = 2;

const tripKey = (from: LonLat, to: LonLat): string => `${from.join(",")} ${to.join(",")}`;

/** Whether `build` serves the trip `trip` with least region `least`. */
const serves = (build: Build, least: Bbox, trip: string): boolean =>
  build.region === undefined ? build.trip === trip : holds(build.region, least);

/**
 * A corridor for the trip on signalk-underkeel's depth survey (`corridor.ts`), when it serves
 * one: undefined when it does not, or the survey fails or joins the ends by none.
 */
async function corridor(
  api: Preparing,
  from: LonLat,
  to: LonLat,
  draft: number,
  stop: AbortSignal
): Promise<Bbox[] | undefined> {
  if (!canSurvey(api)) {
    return undefined;
  }
  const s = await api.survey(surveyRegion(from, to), SURVEY_CELL, stop);
  return s.ok ? corridorFor(s.value, from, to, draft) : undefined;
}

/**
 * The index for `first`, the whole search region; when that is too large to build on the
 * machine (413), for the trip's least region; and when that is too, for a corridor on the
 * depth survey. `narrow` is told each region it turns to, undefined for the corridor: past the
 * region the chart reads no coverage, `unverified`, and the search keeps to the water it can
 * check.
 */
async function prepareTrip(
  api: Preparing,
  trip: { from: LonLat; to: LonLat; draft: number; first: Bbox; least: Bbox },
  stop: AbortSignal,
  narrow: (to: Bbox | undefined) => void
): Promise<PrepareResult> {
  const { first, least } = trip;
  let r = await api.prepare(first, stop);
  if (!r.ok && r.status === 413 && first !== least) {
    narrow(least);
    r = await api.prepare(least, stop);
  }
  if (r.ok || r.status !== 413) {
    return r;
  }
  const parts = await corridor(api, trip.from, trip.to, trip.draft, stop);
  if (!parts) {
    return r;
  }
  narrow(undefined);
  return api.prepare(boxOf(parts), stop, parts);
}

/** The trips' indexes being built, each carried on past the request that asked for it. */
export class Preparer {
  private readonly builds = new Set<Build>();

  constructor(private readonly waitMs = PREPARE_WAIT_MS) {}

  /** A build that serves the trip, else a new one for it. */
  private buildFor(
    api: Preparing,
    from: LonLat,
    to: LonLat,
    draft: number,
    stop: AbortSignal
  ): Build {
    const least = tripRegion(from, to);
    const trip = tripKey(from, to);
    for (const b of this.builds) {
      if (serves(b, least, trip)) {
        return b;
      }
    }
    const whole = searchRegion(from, to);
    const first = holds(least, whole) ? least : whole;
    let settle: () => void = () => undefined;
    const fresh = (): Promise<"narrowed"> =>
      new Promise((resolve) => {
        settle = () => resolve("narrowed");
      });
    const narrow = (region: Bbox | undefined): void => {
      build.region = region;
      const was = settle;
      build.narrowed = fresh();
      was();
    };
    const build: Build = {
      region: first,
      trip,
      narrowed: fresh(),
      result: prepareTrip(api, { from, to, draft, first, least }, stop, narrow)
        .catch((err: Error): PrepareResult => ({ ok: false, status: 503, error: err.message }))
        .then((r) => {
          this.builds.delete(build);
          return r;
        })
    };
    this.builds.add(build);
    return build;
  }

  /**
   * The planning API over an index for the trip `from`–`to`; `api` itself when it serves no
   * `prepare`; BUILDING while the index is still being built after `waitMs`; the provider's
   * refusal as a reply. A build whose region holds the trip's least region is shared; one that
   * turned past the trip to a smaller region is not, and the trip gets its own, as it does when
   * another trip's region it shared is refused as too large (413). A corridor serves its own
   * trip alone. The build runs until `stop` (the plugin stopping), not the request.
   */
  async forTrip(
    api: PlanningApiV1,
    from: LonLat,
    to: LonLat,
    stop: AbortSignal,
    draft = COARSE_DRAFT
  ): Promise<PlanningApiV1 | Reply> {
    if (!canPrepare(api)) {
      return api;
    }
    const least = tripRegion(from, to);
    const trip = tripKey(from, to);
    const waited = sleep(this.waitMs);
    for (;;) {
      const build = this.buildFor(api, from, to, draft, stop);
      let r = await Promise.race([build.result, build.narrowed, waited]);
      while (r === "narrowed" && serves(build, least, trip)) {
        r = await Promise.race([build.result, build.narrowed, waited]);
      }
      if (r === "narrowed" || (r !== "waiting" && !serves(build, least, trip))) {
        continue;
      }
      if (r === "waiting") {
        return BUILDING;
      }
      // A 413 for another trip's region it shared is no answer for this trip's own: asked again.
      if (!r.ok && r.status === 413 && build.trip !== trip) {
        continue;
      }
      if (!r.ok) {
        return { status: r.status, body: { errors: [r.error] } };
      }
      return onPrepared(api, r.value);
    }
  }
}
