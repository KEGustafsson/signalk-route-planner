import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS } from "../foundation/geo";
import type { ChartObject, PlanningApiV1, SessionParams } from "../oracle/contract";
import type { PlanOptions } from "./options";

/**
 * Credit for the open data an offered route leaned on (plan §5, `attributions`): named only when
 * the route used it, so a plan with none of it shows none. The FTIA's fairway navigation lines
 * reach the planner as `NAVLINE` objects, signalk-underkeel's only source of that class; depths
 * from the Traficom WFS are the only water its route check flags `NOT_FOR_NAVIGATION`.
 */

export interface Attribution {
  source: "ftia" | "traficom";
  text: string;
}

export const FTIA: Attribution = {
  source: "ftia",
  text: "Source: Finnish Transport Infrastructure Agency (Väylävirasto), open data, CC BY 4.0"
};

export const TRAFICOM: Attribution = {
  source: "traficom",
  text: "Contains data from the Finnish Transport and Communications Agency Traficom, CC BY 4.0"
};

/** The class of chart object signalk-underkeel lists for the FTIA's navigation lines. */
const FTIA_CLASS = "NAVLINE";

/** The route is sampled this often when it is held against the lines, metres. */
const SAMPLE_METRES = 25;

/** A route keeps to a line when this much of it runs along it, within the line's reach, metres. */
const KEPT_METRES = 100;

/** Along a line: the route's way within this of the line's, either way, degrees. */
const ALONG_DEGREES = 30;

const DEG = Math.PI / 180;

type XY = [number, number];

/** Metres east and north of `origin`: the route's few km are flat enough. */
function local(origin: LonLat): (p: LonLat) => XY {
  const k = EARTH_RADIUS * DEG;
  const c = Math.cos(origin[1] * DEG);
  return (p) => [(p[0] - origin[0]) * k * c, (p[1] - origin[1]) * k];
}

function toSegment(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

interface Piece {
  at: XY;
  length: number;
  /** The way the route runs there, a unit vector. */
  way: XY;
}

/** The midpoints of `route` cut in pieces of at most `SAMPLE_METRES`, each with its length. */
function pieces(route: readonly XY[]): Piece[] {
  const out: Piece[] = [];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1] as XY;
    const b = route[i] as XY;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d === 0) {
      continue;
    }
    const way: XY = [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
    const n = Math.ceil(d / SAMPLE_METRES);
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      out.push({ at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], length: d / n, way });
    }
  }
  return out;
}

/** Whether a piece of route runs along the segment a–b, either way. */
function along(p: Piece, a: XY, b: XY): boolean {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const cos = len === 0 ? 0 : Math.abs((p.way[0] * (b[0] - a[0]) + p.way[1] * (b[1] - a[1])) / len);
  return cos >= Math.cos((ALONG_DEGREES * Math.PI) / 180);
}

/**
 * Whether `route` keeps to one of `lines`: `KEPT_METRES` of it run along them, within `reach`
 * metres and in their direction. Crossing a fairway, or meeting a line at the start, is not
 * keeping to it.
 */
export function keepsTo(
  route: readonly LonLat[],
  lines: readonly (readonly LonLat[])[],
  reach: number
): boolean {
  const first = route[0];
  if (!first || lines.length === 0) {
    return false;
  }
  const xy = local(first);
  const segs = lines.flatMap((l) => l.slice(1).map((b, i) => [xy(l[i] as LonLat), xy(b)] as const));
  let kept = 0;
  for (const p of pieces(route.map(xy))) {
    if (segs.some(([a, b]) => toSegment(p.at, a, b) <= reach && along(p, a, b))) {
      kept += p.length;
      if (kept >= KEPT_METRES) {
        return true;
      }
    }
  }
  return false;
}

/** The data an offered route leaned on: its legs' flags, and the FTIA lines it kept to. */
export function attributionsOf(
  route: readonly LonLat[],
  legs: readonly { flags?: readonly string[] }[],
  ftiaLines: readonly (readonly LonLat[])[],
  reach: number
): Attribution[] {
  return [
    ...(keepsTo(route, ftiaLines, reach) ? [FTIA] : []),
    ...(legs.some((l) => l.flags?.includes("NOT_FOR_NAVIGATION")) ? [TRAFICOM] : [])
  ];
}

/** `route`'s box grown by `reach` metres: south-west and north-east corners. */
function boxOf(route: readonly LonLat[], reach: number): [LonLat, LonLat] {
  const lons = route.map((p) => p[0]);
  const lats = route.map((p) => p[1]);
  const dLat = reach / (EARTH_RADIUS * DEG);
  const mid = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLon = dLat / Math.max(Math.cos(mid * DEG), 1e-6);
  return [
    [Math.min(...lons) - dLon, Math.min(...lats) - dLat],
    [Math.max(...lons) + dLon, Math.max(...lats) + dLat]
  ];
}

const ftiaOf = (objects: readonly ChartObject[]): LonLat[][] =>
  objects
    .filter((o) => o.class === FTIA_CLASS && o.geometry.type === "LineString")
    .map((o) => o.geometry.coordinates as LonLat[]);

/**
 * The FTIA navigation lines about `route`, listed in a session of their own: over the route's
 * box, or leg by leg when that is too large to list. `undefined` when they cannot be listed.
 */
export async function ftiaLinesAbout(
  api: PlanningApiV1,
  params: SessionParams,
  route: readonly LonLat[],
  reach: number,
  signal: AbortSignal
): Promise<LonLat[][] | undefined> {
  if (!api.features?.includes("objects") || route.length < 2) {
    return [];
  }
  const r = await api.session(params, signal, (s) => {
    const list = s.objects;
    if (!list) {
      return Promise.resolve([]);
    }
    try {
      return Promise.resolve(ftiaOf(list(...boxOf(route, reach))));
    } catch (err) {
      if (!(err instanceof RangeError)) {
        throw err;
      }
    }
    // A route too large to list in one box is listed leg by leg; a leg too large, not at all.
    try {
      return Promise.resolve(
        route.slice(1).flatMap((b, i) => ftiaOf(list(...boxOf([route[i] as LonLat, b], reach))))
      );
    } catch (err) {
      if (err instanceof RangeError) {
        return Promise.resolve(undefined);
      }
      throw err;
    }
  });
  return r.ok ? r.value : undefined;
}

interface Credited {
  route: { coordinates: LonLat[] };
  check: { legs: readonly { flags?: readonly string[] }[] };
}

/**
 * The offered route's reply `body` with the data its route leaned on credited (`attributions`).
 * `opts` are the options its search ran with: the FTIA's lines are kept to only with lines on
 * and a weight for them, and within their reach. When they cannot be listed the FTIA is credited
 * all the same, as a route that may have kept to them.
 */
export async function credited<T extends Credited>(
  api: PlanningApiV1,
  input: { departure: number; speed: number },
  signal: AbortSignal,
  body: T,
  opts: PlanOptions
): Promise<T & { attributions: Attribution[] }> {
  const route = body.route.coordinates;
  const { preferReach: reach, minWindow } = opts;
  const params = {
    departure: input.departure,
    until: input.departure + minWindow,
    speed: input.speed
  };
  const kept = opts.preferLines && opts.preferWeight > 0;
  const lines = kept ? await ftiaLinesAbout(api, params, route, reach, signal) : [];
  const found = attributionsOf(route, body.check.legs, lines ?? [], reach);
  const attributions = lines === undefined && !found.includes(FTIA) ? [FTIA, ...found] : found;
  return { ...body, attributions };
}
