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
  /**
   * The boat's height above the waterline, metres, in place of the vessel's: with feature
   * "objects", boxes and legs under a bridge or overhead cable too low at the window's highest
   * water fail (`AIR_DRAFT`).
   */
  airHeight?: number;
}

/**
 * A chart object a session lists (feature "objects"): a bridge or overhead cable with its
 * clearance, a restricted area, a traffic lane, or a line a route may keep to (`NAVLNE`,
 * `RECTRC`, a fairway's navigation line, the boat's own track).
 */
export interface ChartObject {
  class: string;
  geometry:
    | { type: "Point"; coordinates: LonLat }
    | { type: "LineString"; coordinates: LonLat[] }
    | { type: "MultiPolygon"; coordinates: LonLat[][][] };
  clearance?: number;
  restrictions?: number[];
  orient?: number;
  /** A line with traffic both ways along it, which a boat keeps to starboard of. */
  twoWay?: boolean;
  /** The draft a fairway's navigation line is laid out for, metres. */
  designDraft?: number;
  cell?: string;
}

/**
 * A session's raster of a block of chart (feature "raster"): each cell's status for the
 * session's vessel and window, from signalk-underkeel 0.8.0. A cell is one of the index's
 * finest tiles, at Web Mercator zoom `z`.
 */
export interface Raster {
  z: number;
  /** Tile column and row of the north-west cell. */
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  /** One byte a cell (`RASTER`), row by row from the north-west. */
  cells: Uint8Array;
  /** Per cell, the index in `flagSets` of its verdict's flags. */
  flags: Uint8Array;
  flagSets: string[][];
  /** How far past a corridor a tile still counts in its verdict, ground metres. */
  reach: number;
}

/** A raster cell's byte: bits 0–1 index `RASTER_STATUS`, the others as named. */
export const RASTER = {
  STATUS: 3,
  /** P(UKC < 0) at or above the session's accepted probability. */
  RISKY: 4,
  /** No water level in the session's window betters the cell. */
  STUCK: 8,
  /** The cell is split finer than the raster: its status is its parts' together. */
  MIXED: 64,
  /** Nothing here answers for a leg: one reaching the cell is asked of `segment`. */
  ASK: 128
} as const;

export const RASTER_STATUS: readonly Status[] = ["ok", "marginal", "fail", "unverified"];

/** What the search asks of the chart: the part of a session it uses. */
export interface Session {
  readonly halfWidth: number;
  box(sw: LonLat, ne: LonLat, window?: Window): Verdict;
  segment(a: LonLat, b: LonLat, window?: Window): Verdict;
  /** With feature "objects": the chart objects whose bounds meet the box sw–ne. */
  objects?(sw: LonLat, ne: LonLat): ChartObject[];
  /** With feature "raster": the zoom of the raster's cells. */
  readonly rasterZoom?: number;
  /**
   * With feature "raster": the raster of `cols` × `rows` cells whose north-west cell is tile
   * (x0, y0) at `rasterZoom`. Throws RangeError for a block too large or off the tile grid.
   */
  raster?(x0: number, y0: number, cols: number, rows: number): Raster;
  work(): number;
  pause(): Promise<void>;
  /**
   * The boxes the index was built in when they are a corridor's, set by the planner
   * (`onPrepared`), not by the provider: past them the chart reads no coverage, so the search
   * asks about no square that reaches past them.
   */
  readonly within?: readonly Bbox[];
}

export type SessionResult<T> =
  { ok: true; value: T } | { ok: false; status: number; error: string };

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** [west, south, east, north], degrees. */
export type Bbox = [number, number, number, number];

/**
 * An index prepared for a region (`prepare`): the session and route check over it. Its
 * queries are judged on the charts wherever a box's or leg's corridor lies in the region.
 */
export interface Prepared {
  /** The box the index was built in; undefined for a whole index. */
  readonly coverage: Bbox | undefined;
  session<T>(
    params: SessionParams,
    signal: AbortSignal,
    job: (s: Session) => Promise<T>
  ): Promise<SessionResult<T>>;
  routeCheck(body: unknown, signal: AbortSignal): Promise<Reply>;
  release(): void;
}

export type PrepareResult =
  { ok: true; value: Prepared } | { ok: false; status: number; error: string };

/** A coarse depth grid over a region (`survey`): for choosing a corridor, never a verdict. */
export interface Survey {
  /** The grid's extent: the region rounded out to whole cells. */
  readonly bbox: Bbox;
  readonly cols: number;
  readonly rows: number;
  /** Cell side, metres: north–south, and east–west at the grid's middle latitude. */
  readonly cellMetres: number;
  /**
   * The deepest charted depth touching each cell, metres below chart datum; NaN where none
   * does. Row-major, row 0 the southernmost, column 0 the westernmost.
   */
  readonly depth: Float32Array;
  /**
   * The shallowest charted depth touching each cell, in the same order: a cell whose shallowest
   * takes a draft is deep enough all over. Absent from a provider before signalk-underkeel 0.8.0.
   */
  readonly shallowest?: Float32Array;
}

export type SurveyResult =
  { ok: true; value: Survey } | { ok: false; status: number; error: string };

export interface PlanningApiV1 {
  readonly version: 1;
  readonly provider: string;
  /** Additions to version 1 the provider serves; absent from one that serves none. */
  readonly features?: readonly string[];
  unavailable(): string | undefined;
  coverage(): [number, number, number, number] | undefined;
  /**
   * The route check's settings, and the vessel's `draft` a session without one takes, from
   * signalk-underkeel 0.8.0 while it knows one.
   */
  defaults(): {
    speed: number;
    xteLimit: number;
    probability: number;
    planningBuffer: number;
    draft?: number;
  };
  session<T>(
    params: SessionParams,
    signal: AbortSignal,
    job: (s: Session) => Promise<T>
  ): Promise<SessionResult<T>>;
  routeCheck(body: unknown, signal: AbortSignal): Promise<Reply>;
  /**
   * With `features` listing "prepare": an index for `region`, the chart box around the vessel
   * when it covers it, else a planning box built for it, which can take minutes.
   */
  prepare?(
    region: Bbox,
    signal: AbortSignal,
    corridor?: readonly Bbox[],
    /**
     * With `features` listing "held" (signalk-underkeel 0.8.0): `held` asks for no build, only
     * an index already there that serves the region, 404 when there is none.
     */
    how?: { held?: boolean }
  ): Promise<PrepareResult>;
  /**
   * With `features` listing "survey": the depth survey of `region`, cells about `cellMetres`
   * on a side or coarser, made tile by tile, so it reaches far past any planning box. With
   * "corridor", `prepare` takes the boxes within `region` a corridor is cut into and builds
   * them alone; past them the index reads no coverage.
   */
  survey?(region: Bbox, cellMetres: number, signal: AbortSignal): Promise<SurveyResult>;
}

/** Whether `api` serves `survey` and corridors, for a trip past what a planning box holds. */
export function canSurvey(
  api: PlanningApiV1
): api is PlanningApiV1 & Required<Pick<PlanningApiV1, "prepare" | "survey">> {
  return (
    canPrepare(api) &&
    api.features?.includes("survey") === true &&
    api.features.includes("corridor") &&
    typeof api.survey === "function"
  );
}

/** Whether `api` says what index it holds for a region without building one (feature "held"). */
export function canPeek(
  api: PlanningApiV1
): api is PlanningApiV1 & Required<Pick<PlanningApiV1, "prepare">> {
  return canPrepare(api) && api.features?.includes("held") === true;
}

/** Whether `api` serves `prepare` (signalk-underkeel's planning boxes). */
export function canPrepare(
  api: PlanningApiV1
): api is PlanningApiV1 & Required<Pick<PlanningApiV1, "prepare">> {
  return api.features?.includes("prepare") === true && typeof api.prepare === "function";
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
