import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, frameAt, haversine, midpoint } from "../foundation/geo";
import type { PlanOptions } from "./options";
import { DEFAULT_PLAN, limitsFor } from "./options";
import type {
  Bbox,
  PlanningApiV1,
  Prepared,
  PrepareResult,
  Reply,
  Session,
  Survey
} from "../oracle/contract";
import { canPeek, canPrepare, canSurvey } from "../oracle/contract";
import { rasterOf } from "../search/field";
import { boxOf, corridorsFor, mosaic, SURVEY_CELL, surveyRegion, surveyTiles } from "./corridor";

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
/**
 * Seconds the 503 asks the client to wait before it plans again. Short: the request asked
 * again waits `PREPARE_WAIT_MS` for the build itself, so the plan is answered within seconds of
 * the index being built, where a long pause here was added to every build that outlasted one wait.
 */
export const RETRY_AFTER_S = 3;

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

/** A snug region reaches past the trip's ends by this share of its length, or PREPARE_MARGIN. */
export const SNUG_SHARE = 0.25;
/** A snug region's edges lie on this grid, degrees of latitude and of longitude. */
const SNAP_LAT = 0.025;
const SNAP_LON = 0.05;

/**
 * The region a trip is first prepared in: the box of its ends grown by a quarter of its length
 * (at least `tripRegion`'s margin), its edges moved out to a grid, and no part of it past the
 * whole search region's box. It is a third to a half of the whole region's area, so its index
 * is downloaded and built in that share of the time; on the grid, a trip whose ends moved a
 * little asks for the same region, which signalk-underkeel then holds already. A route found in
 * it stands when no route leaving it could be shorter (`leavingAtLeast`); otherwise the whole
 * region is prepared (`Preparer.forTrip`, `wide`).
 */
export function snugRegion(from: LonLat, to: LonLat, opts: PlanOptions = DEFAULT_PLAN): Bbox {
  const margin = Math.max(PREPARE_MARGIN, haversine(from, to) * SNUG_SHARE);
  const [w, s, e, n] = around([from, to], margin);
  const snapped: Bbox = [
    Math.floor(w / SNAP_LON) * SNAP_LON,
    Math.max(-85, Math.floor(s / SNAP_LAT) * SNAP_LAT),
    Math.ceil(e / SNAP_LON) * SNAP_LON,
    Math.min(85, Math.ceil(n / SNAP_LAT) * SNAP_LAT)
  ];
  // Never more than the whole region and the grid squares its edges lie in.
  const whole = searchRegion(from, to, opts);
  return holds(snapped, whole) ? whole : snapped;
}

/**
 * The least length, metres, of any way from `from` to `to` that leaves `region`: it touches an
 * edge, so it is at least the way from one end to that edge and on to the other, the shortest
 * of which reflects an end in the edge. Infinity when an end lies outside the region.
 */
export function leavingAtLeast(from: LonLat, to: LonLat, region: Bbox): number {
  const frame = frameAt(midpoint(from, to));
  const [ax, ay] = frame.toXY(from);
  const [bx, by] = frame.toXY(to);
  const [x0, y0] = frame.toXY([region[0], region[1]]);
  const [x1, y1] = frame.toXY([region[2], region[3]]);
  // The frame's east–west scale is the midpoint's: the edges are taken a little nearer.
  const west = x0 * EDGE_NEAR;
  const east = x1 * EDGE_NEAR;
  const south = y0 * EDGE_NEAR;
  const north = y1 * EDGE_NEAR;
  if (ax < west || ax > east || bx < west || bx > east) {
    return Infinity;
  }
  if (ay < south || ay > north || by < south || by > north) {
    return Infinity;
  }
  // Reflected in an edge's line; the foot may lie past the edge's ends, where the true least
  // is longer still, so the line's is a lower bound.
  const viaX = (x: number): number => Math.hypot(2 * x - ax - bx, ay - by);
  const viaY = (y: number): number => Math.hypot(ax - bx, 2 * y - ay - by);
  return Math.min(viaX(west), viaX(east), viaY(south), viaY(north));
}

/** The share of an edge's distance from the trip's middle counted, for the frame's scale. */
const EDGE_NEAR = 0.98;

/**
 * Every place the search may ask about: the square its region is cut from, half side
 * d/2 + max(d/2, minMargin) around the midpoint (`shapeFor`, `region.ts`), and a harbour stage's region around
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

/**
 * Whether a trip `d` metres long is past `maxDistance` where `api`, the provider, can survey:
 * then it is prepared and planned with a corridor's limits, in a corridor or, where the machine
 * builds its region, in a planning box.
 */
export function longTrip(api: PlanningApiV1, d: number, opts: PlanOptions = DEFAULT_PLAN): boolean {
  return d > opts.maxDistance && canSurvey(api);
}

/**
 * The limits `/plan` gives a trip `d` metres long on `prepared`, the index for it from the
 * provider `api`: a corridor's for a long trip (`longTrip`) or one planned in a corridor.
 */
export function tripLimits(
  api: PlanningApiV1,
  prepared: PlanningApiV1,
  d: number,
  opts: PlanOptions = DEFAULT_PLAN
): PlanOptions {
  return limitsFor(opts, d, longTrip(api, d, opts) || inCorridor(prepared));
}

/**
 * The features a session has on any index, as the provider's own: holding legs to bridges and
 * listing the chart objects, the lines a route keeps to among them.
 */
const SESSION_FEATURES = new Set(["objects"]);

/** The planning APIs over a corridor's index (`onPrepared`), for `inCorridor`. */
const CORRIDORS = new WeakSet<PlanningApiV1>();

/** Whether `api` is over a corridor's index: its trip is planned with a corridor's limits. */
export function inCorridor(api: PlanningApiV1): boolean {
  return CORRIDORS.has(api);
}

/**
 * `api` with its session and route check over the prepared index `p`; its sessions carry
 * `corridor`, the boxes `p` was built in when they are a corridor's (`Session.within`).
 */
export function onPrepared(
  api: PlanningApiV1,
  p: Prepared,
  corridor?: readonly Bbox[]
): PlanningApiV1 {
  // Of the provider's features, those a session over the prepared index still serves.
  const features = api.features?.filter((f) => SESSION_FEATURES.has(f));
  const over: PlanningApiV1 = {
    version: 1,
    provider: api.provider,
    ...(features && { features }),
    unavailable: () => api.unavailable(),
    coverage: () => p.coverage,
    defaults: () => api.defaults(),
    session: (params, signal, job) =>
      p.session(
        params,
        signal,
        corridor === undefined ? job : (s) => job(withinCorridor(s, corridor))
      ),
    routeCheck: (body, signal) => p.routeCheck(body, signal)
  };
  if (corridor !== undefined) {
    CORRIDORS.add(over);
  }
  return over;
}

/** `s` that says its index lies within `corridor`'s boxes. */
const withinCorridor = (s: Session, corridor: readonly Bbox[]): Session => ({
  halfWidth: s.halfWidth,
  box: (sw, ne, window) => s.box(sw, ne, window),
  segment: (a, b, window) => s.segment(a, b, window),
  ...(s.objects && { objects: s.objects.bind(s) }),
  ...rasterOf(s),
  work: () => s.work(),
  pause: () => s.pause(),
  within: corridor
});

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
  result: Promise<Prepping>;
  narrowed: Promise<"narrowed">;
}

type Preparing = PlanningApiV1 & Required<Pick<PlanningApiV1, "prepare">>;

/** A build's result, with the corridor's boxes when it was built for one. */
type Prepping = PrepareResult & { corridor?: readonly Bbox[] };

/** The draft the corridor is found for when the request gives none, metres. */
export const COARSE_DRAFT = 2;

/** A trip's identity for its corridor: the ends and the draft the corridor is found for. */
const tripKey = (from: LonLat, to: LonLat, draft: number): string =>
  `${from.join(",")} ${to.join(",")} ${draft}`;

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
): Promise<Bbox[][] | undefined> {
  if (!canSurvey(api)) {
    return undefined;
  }
  const s = await surveyAlong(api, from, to, stop);
  return s && corridorsFor(s, from, to, draft);
}

/** A long trip's survey is cut into at most this many pieces along its line. */
const MAX_SURVEY_TILES = 8;

/**
 * The depth survey along the trip: of its whole region, or when signalk-underkeel refuses that
 * as too large (413), of the trip cut into more pieces along its line in turn (`surveyTiles`),
 * each surveyed alone and joined into one grid (`mosaic`). Undefined when a survey fails.
 */
async function surveyAlong(
  api: Required<Pick<PlanningApiV1, "survey">>,
  from: LonLat,
  to: LonLat,
  stop: AbortSignal
): Promise<Survey | undefined> {
  const whole = await api.survey(surveyRegion(from, to), SURVEY_CELL, stop);
  if (whole.ok || whole.status !== 413) {
    return whole.ok ? whole.value : undefined;
  }
  for (let n = 2; n <= MAX_SURVEY_TILES; n++) {
    const grids: Survey[] = [];
    for (const region of surveyTiles(from, to, n)) {
      const r = await api.survey(region, SURVEY_CELL, stop);
      if (!r.ok) {
        if (r.status !== 413) {
          return undefined;
        }
        break;
      }
      grids.push(r.value);
    }
    if (grids.length === n) {
      return mosaic(grids);
    }
  }
  return undefined;
}

/**
 * The index for `first`, the whole search region; when that is too large to build on the
 * machine (413), for the trip's least region; and when that is too, for a corridor on the
 * depth survey, narrower in turn (`CORRIDOR_WIDTHS`) while it is too. `narrow` is told each region it turns to, undefined for the corridor: past the
 * region the chart reads no coverage, `unverified`, and the search keeps to the water it can
 * check.
 */
async function prepareTrip(
  api: Preparing,
  trip: { from: LonLat; to: LonLat; draft: number; first: Bbox; least: Bbox },
  stop: AbortSignal,
  narrow: (to: Bbox | undefined) => void
): Promise<Prepping> {
  const { first, least } = trip;
  let r = await api.prepare(first, stop);
  if (!r.ok && r.status === 413 && first !== least) {
    narrow(least);
    r = await api.prepare(least, stop);
  }
  if (r.ok || r.status !== 413) {
    return r;
  }
  const corridors = await corridor(api, trip.from, trip.to, trip.draft, stop);
  if (!corridors) {
    return r;
  }
  narrow(undefined);
  // Narrower in turn while the machine refuses a corridor as too large to build.
  for (const parts of corridors) {
    r = await api.prepare(boxOf(parts), stop, parts);
    if (r.ok) {
      return { ...r, corridor: parts };
    }
    if (r.status !== 413) {
      return r;
    }
  }
  return r;
}

/**
 * The planning API over an index the provider holds already that covers `least`, the trip's own
 * ends; undefined when it holds none, or does not say (feature "held"). What is held serves:
 * no build is asked for a region a little to one side of it. The plan made on it is planned
 * again in a larger region when a route leaving it could be shorter.
 */
async function heldFor(
  api: Preparing,
  least: Bbox,
  stop: AbortSignal
): Promise<PlanningApiV1 | undefined> {
  if (!canPeek(api)) {
    return undefined;
  }
  const held = await api.prepare(least, stop, undefined, { held: true });
  return held.ok ? onPrepared(api, held.value) : undefined;
}

/** How much of a trip's search region an index is asked to cover (`Preparer.forTrip`). */
export type Reach = "held" | "snug" | "whole";

/** The trips' indexes being built, each carried on past the request that asked for it. */
export class Preparer {
  private readonly builds = new Set<Build>();

  constructor(private readonly waitMs = PREPARE_WAIT_MS) {}

  /** Whether an index is being built for some trip. */
  get busy(): boolean {
    return this.builds.size > 0;
  }

  /**
   * A build that serves the trip, else a new one for it: for its snug region, or with `reach`
   * "whole" for the whole search region.
   */
  private buildFor(
    api: Preparing,
    [from, to]: [LonLat, LonLat],
    draft: number,
    stop: AbortSignal,
    reach: Reach
  ): Build {
    const least = tripRegion(from, to);
    const trip = tripKey(from, to, draft);
    const whole = searchRegion(from, to);
    const snug = snugRegion(from, to);
    // A build for the region asked for: one in progress for a smaller one does not serve it.
    const need = reach === "whole" ? whole : reach === "snug" ? snug : least;
    for (const b of this.builds) {
      if (serves(b, need, trip) && (reach === "held" || b.region !== undefined)) {
        return b;
      }
    }
    const first = holds(least, whole) ? least : reach === "whole" ? whole : snug;
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
        .catch((err: Error): Prepping => ({ ok: false, status: 503, error: err.message }))
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
   *
   * By `reach`: "held", an index the provider holds already when it covers the trip's own
   * ends, else one built for the trip's snug region (`snugRegion`), a part of the search region
   * that takes a part of the time to build; "snug", one that covers the snug region; "whole",
   * the whole search region. A plan asks for the next when the route it found may be beaten by
   * one leaving the region it was planned in.
   */
  async forTrip(
    api: PlanningApiV1,
    from: LonLat,
    to: LonLat,
    stop: AbortSignal,
    draft = COARSE_DRAFT,
    reach: Reach = "held"
  ): Promise<PlanningApiV1 | Reply> {
    if (!canPrepare(api)) {
      return api;
    }
    const held = reach === "held" ? await heldFor(api, tripRegion(from, to), stop) : undefined;
    return held ?? this.built(api, [from, to], stop, draft, reach);
  }

  /** `forTrip` by a build: one that serves the trip, waited for `waitMs`. */
  private async built(
    api: Preparing,
    [from, to]: [LonLat, LonLat],
    stop: AbortSignal,
    draft: number,
    reach: Reach
  ): Promise<PlanningApiV1 | Reply> {
    const least = tripRegion(from, to);
    const trip = tripKey(from, to, draft);
    const waited = sleep(this.waitMs);
    for (;;) {
      const build = this.buildFor(api, [from, to], draft, stop, reach);
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
      return onPrepared(api, r.value, r.corridor);
    }
  }
}
