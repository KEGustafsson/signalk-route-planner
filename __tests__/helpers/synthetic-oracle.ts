import type { LonLat } from "../../src/foundation/geo";
import { frameAt, haversine } from "../../src/foundation/geo";
import type {
  PlanningApiV1,
  Reply,
  Session,
  SessionParams,
  Status,
  Verdict
} from "../../src/oracle/contract";

/**
 * A planning API over a plane of circles, for tests: an obstacle circle fails
 * any box or leg whose corridor reaches it, an unverified circle makes it
 * unverified. Distances are exact in a local frame at ORIGIN.
 */

export const ORIGIN: LonLat = [22.0, 60.0];
const FRAME = frameAt(ORIGIN);

export interface Circle {
  /** Centre, metres east and north of ORIGIN. */
  x: number;
  y: number;
  r: number;
}

export interface Chart {
  /**
   * Land: fails and is never crossed (flag LAND). A leg whose own line lies over it, past the
   * land at its own ends, is flagged LAND_CROSSED too (`crossesLand`).
   */
  obstacles: Circle[];
  /** Charted shallows: fail, but the fallback may cross them. */
  shallows?: Circle[];
  unverified?: Circle[];
  /** Water the check passes with a warning: marginal, at P(UKC < 0) 0.005. */
  marginal?: Circle[];
  /** Water the check passes, `ok`, at this P(UKC < 0): near the margin, not over it. */
  risky?: (Circle & { risk: number })[];
  /** Shallows that pass once the water level is at least `needs` metres: a tide gate. */
  tidal?: (Circle & { needs: number })[];
  /** The water level at time t, metres; 0 when absent. */
  tide?: (t: number) => number;
  /**
   * Bridges, each with its clearance above the water level's datum, metres: a boat whose air
   * height plus 0.5 m is above the clearance less the highest water while it is there fails
   * (`AIR_DRAFT`), as signalk-underkeel holds it.
   */
  bridges?: (Circle & { clearance: number })[];
  /** Lines a session lists as chart objects (feature "objects"), metres east and north. */
  lines?: { class: string; points: [number, number][]; twoWay?: boolean; designDraft?: number }[];
  /** Areas a session lists as chart objects, such as anchorages: one ring, metres east and north. */
  areas?: { class: string; ring: [number, number][]; restrictions?: number[] }[];
  /** Closed water carrying its own flag, such as an entry-prohibited area: fails. */
  closed?: (Circle & { flag: string })[];
  /** Corridor half-width, metres. */
  halfWidth?: number;
  /** Every chart is marked not for navigation: clear water is `unverified`, NOT_FOR_NAVIGATION. */
  notForNavigation?: boolean;
}

export const at = (x: number, y: number): LonLat => FRAME.toLonLat(x, y);
export const xy = (p: LonLat): [number, number] => FRAME.toXY(p);

/** Distance from point (px, py) to segment a–b. */
export function segDist(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function rectDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dy = Math.max(y0 - py, 0, py - y1);
  return Math.hypot(dx, dy);
}

/** The highest water level over [start, end], sampled each minute and at the end. */
function highest(chart: Chart, w?: { start: number; end: number }): number {
  if (!chart.tide || !w) {
    return chart.tide?.(0) ?? 0;
  }
  let h = chart.tide(w.end);
  for (let t = w.start; t < w.end; t += 60_000) {
    h = Math.max(h, chart.tide(t));
  }
  return h;
}

/** The boat's air height and the highest water a verdict holds for, when it has one. */
export interface Air {
  height: number;
  level: number;
}

/** The lowest water level over [start, end], sampled each minute and at the end. */
function lowest(chart: Chart, w?: { start: number; end: number }): number {
  if (!chart.tide || !w) {
    return chart.tide?.(0) ?? 0;
  }
  let h = chart.tide(w.end);
  for (let t = w.start; t < w.end; t += 60_000) {
    h = Math.min(h, chart.tide(t));
  }
  return h;
}

/**
 * What water within `near` of the corridor gets at water level `level`: land, closed,
 * shallows (a tidal shoal without water enough among them), unverified or clear.
 */
function judge(chart: Chart, near: (c: Circle) => boolean, level = 0, air?: Air): Verdict {
  const v = judgeDepth(chart, near, level);
  const low = (chart.bridges ?? []).some(
    (b) => air !== undefined && near(b) && b.clearance - air.level < air.height + 0.5
  );
  return low ? { status: "fail", risk: v.risk, flags: [...v.flags, "AIR_DRAFT"] } : v;
}

function judgeDepth(chart: Chart, near: (c: Circle) => boolean, level: number): Verdict {
  // Every flag the corridor meets is reported, as the route check reports them all; the
  // worst status decides.
  const land = chart.obstacles.some(near);
  const closed = (chart.closed ?? []).filter(near).map((c) => c.flag);
  const dry = (chart.tidal ?? []).some((c) => near(c) && level < c.needs);
  const shallow = dry || (chart.shallows ?? []).some(near);
  const unverified = (chart.unverified ?? []).some(near);
  const flags = [...(land ? ["LAND"] : []), ...closed, ...(unverified ? ["NO_COVERAGE"] : [])];
  if (land || shallow) {
    return { status: "fail", risk: 0.9, flags };
  }
  if (closed.length > 0) {
    return { status: "fail", risk: 0, flags };
  }
  if (unverified) {
    return { status: "unverified", risk: 0, flags };
  }
  if ((chart.marginal ?? []).some(near)) {
    // As underkeel: a flag that leaves the water unchecked makes it unverified, not marginal.
    return chart.notForNavigation
      ? { status: "unverified", risk: 0.005, flags: ["NOT_FOR_NAVIGATION"] }
      : { status: "marginal", risk: 0.005, flags: [] };
  }
  const risk = Math.max(0, ...(chart.risky ?? []).filter(near).map((c) => c.risk));
  return chart.notForNavigation
    ? { status: "unverified", risk, flags: ["NOT_FOR_NAVIGATION"] }
    : { status: "ok", risk, flags: [] };
}

/** The verdict of the leg a → b on `chart` with corridor half-width r. */
export function legVerdict(
  chart: Chart,
  a: LonLat,
  b: LonLat,
  r: number,
  level = 0,
  air?: Air
): Verdict {
  const pa = xy(a);
  const pb = xy(b);
  const v = judge(chart, (c) => segDist(c.x, c.y, pa, pb) < c.r + r, level, air);
  return v.flags.includes("LAND") && crossesLand(chart, pa, pb)
    ? { ...v, flags: [...v.flags, "LAND_CROSSED"] }
    : v;
}

/** Land at a leg's own end is not crossed as far as this from the end, metres, at least. */
const OWN_LAND = 10;

/** As signalk-underkeel: an end's own land reaches 1.5 times the way to the nearest water, and 5 m. */
const NEAREST_WATER_SLACK = 1.5;
const TILE = 5;

const onLand = (chart: Chart, x: number, y: number): boolean =>
  chart.obstacles.some((c) => Math.hypot(x - c.x, y - c.y) < c.r);

const waterWays = new WeakMap<Chart, Map<string, number>>();

/** The way from (x, y) to the nearest point no obstacle holds, metres, in 1 m steps; 0 in water. */
function toWater(chart: Chart, [x, y]: [number, number]): number {
  let seen = waterWays.get(chart);
  if (!seen) {
    seen = new Map();
    waterWays.set(chart, seen);
  }
  const key = `${x},${y}`;
  const known = seen.get(key);
  if (known !== undefined) {
    return known;
  }
  let best = Infinity;
  for (let k = 0; k < 32; k++) {
    const [dx, dy] = [Math.cos((k * Math.PI) / 16), Math.sin((k * Math.PI) / 16)];
    let d = 0;
    while (d < best && d < 1000 && onLand(chart, x + dx * d, y + dy * d)) {
      d += 1;
    }
    best = Math.min(best, d);
  }
  seen.set(key, best);
  return best;
}

/**
 * Whether the line a–b crosses land, as signalk-underkeel flags it (`LAND_CROSSED`): it lies
 * over an obstacle somewhere that is not the land at its own ends, the stretch of land it runs
 * over from an end without a gap, as far from that end as OWN_LAND, or 1.5 times the way from
 * it to the nearest water and 5 m more: a point put on land leaves it about the nearest way.
 */
function crossesLand(chart: Chart, a: [number, number], b: [number, number]): boolean {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length === 0) {
    return false;
  }
  const [ux, uy] = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  // The stretch of the line inside each obstacle, metres from a.
  const over = chart.obstacles
    .flatMap((c): [number, number][] => {
      const along = (c.x - a[0]) * ux + (c.y - a[1]) * uy;
      const off2 = (c.x - a[0]) ** 2 + (c.y - a[1]) ** 2 - along * along;
      const half = Math.sqrt(c.r * c.r - off2);
      const [from, to] = [Math.max(0, along - half), Math.min(length, along + half)];
      return off2 < c.r * c.r && from < to ? [[from, to]] : [];
    })
    .sort((p, q) => p[0] - q[0]);
  // Obstacles that overlap or touch are one stretch of land: an end owns it whole or not at all.
  const runs: [number, number][] = [];
  for (const [from, to] of over) {
    const last = runs.at(-1);
    if (last && from <= last[1] + 1e-9) {
      last[1] = Math.max(last[1], to);
    } else {
      runs.push([from, to]);
    }
  }
  // The way to the nearest water is walked only for land longer than OWN_LAND at an end.
  const within = (p: [number, number], d: number): boolean =>
    d <= OWN_LAND || d <= NEAREST_WATER_SLACK * toWater(chart, p) + TILE;
  const own = ([from, to]: [number, number]): boolean =>
    (from <= 1e-9 && within(a, to)) || (to >= length - 1e-9 && within(b, length - from));
  return !runs.every(own);
}

/** The status of the leg a → b on `chart`, ignoring a chart marked not for navigation. */
export function legStatus(chart: Chart, a: LonLat, b: LonLat, r: number): Status {
  return legVerdict({ ...chart, notForNavigation: false }, a, b, r).status;
}

export interface Synthetic extends PlanningApiV1 {
  /** Sessions run so far, with the params they got. */
  sessions: SessionParams[];
  boxes: number;
}

export function syntheticApi(
  chart: Chart,
  over: Partial<PlanningApiV1> & { workPerQuery?: number } = {}
): Synthetic {
  // As signalk-underkeel: the corridor half-width is the cross-track limit plus the 10 m
  // planning buffer; without one, the chart's own (40 m by default).
  const widthFor = (xteLimit: number | undefined): number =>
    xteLimit !== undefined ? xteLimit + 10 : (chart.halfWidth ?? 40);
  const per = over.workPerQuery ?? 100;
  const airOver = (
    height: number | undefined,
    w: { start: number; end: number }
  ): Air | undefined => (height === undefined ? undefined : { height, level: highest(chart, w) });
  const api: Synthetic = {
    version: 1,
    provider: "synthetic",
    sessions: [],
    boxes: 0,
    unavailable: () => undefined,
    coverage: () => undefined,
    defaults: () => ({ speed: 3, xteLimit: 30, probability: 0.01, planningBuffer: 10 }),
    async session(params, signal, job) {
      api.sessions.push(params);
      const r = widthFor(params.xteLimit);
      // As signalk-underkeel: a verdict holds at the lowest water of its window.
      const whole = { start: params.departure, end: params.until };
      let work = 0;
      const session: Session = {
        halfWidth: r,
        box(sw, ne, w) {
          work += per;
          api.boxes++;
          const corners = [sw, ne, [sw[0], ne[1]] as LonLat, [ne[0], sw[1]] as LonLat].map(xy);
          const x0 = Math.min(...corners.map((c) => c[0]));
          const x1 = Math.max(...corners.map((c) => c[0]));
          const y0 = Math.min(...corners.map((c) => c[1]));
          const y1 = Math.max(...corners.map((c) => c[1]));
          const level = lowest(chart, w ?? whole);
          const air = airOver(params.airHeight, w ?? whole);
          return judge(chart, (c) => rectDist(c.x, c.y, x0, y0, x1, y1) < c.r + r, level, air);
        },
        segment(a, b, w) {
          // As signalk-underkeel: a leg's corridor over 25 km² is refused.
          if (((haversine(a, b) + 2 * r) * 2 * r) / 1e6 > 25) {
            throw new RangeError("leg corridor over 25 km²");
          }
          work += per;
          const air = airOver(params.airHeight, w ?? whole);
          return legVerdict(chart, a, b, r, lowest(chart, w ?? whole), air);
        },
        objects(sw, ne) {
          const [x0, y0] = xy(sw);
          const [x1, y1] = xy(ne);
          // By bounds, as a provider lists them: a line may cross the box with no point in it.
          const meets = (points: [number, number][]) =>
            Math.max(...points.map((p) => p[0])) >= x0 &&
            Math.min(...points.map((p) => p[0])) <= x1 &&
            Math.max(...points.map((p) => p[1])) >= y0 &&
            Math.min(...points.map((p) => p[1])) <= y1;
          const lines = (chart.lines ?? []).filter((l) => meets(l.points));
          const areas = (chart.areas ?? []).filter((a) => meets(a.ring));
          return [
            ...lines.map((l) => ({
              class: l.class,
              geometry: {
                type: "LineString" as const,
                coordinates: l.points.map(([x, y]) => at(x, y))
              },
              ...(l.twoWay && { twoWay: true }),
              ...(l.designDraft !== undefined && { designDraft: l.designDraft })
            })),
            ...areas.map((a) => ({
              class: a.class,
              geometry: {
                type: "MultiPolygon" as const,
                coordinates: [[a.ring.map(([x, y]) => at(x, y))]]
              },
              ...(a.restrictions && { restrictions: a.restrictions })
            }))
          ];
        },
        work: () => work,
        pause: () =>
          new Promise((resolve, reject) =>
            setImmediate(() => (signal.aborted ? reject(signal.reason) : resolve()))
          )
      };
      try {
        return { ok: true, value: await job(session) };
      } catch (err) {
        if (signal.aborted) {
          return { ok: false, status: 503, error: (err as Error).message };
        }
        throw err;
      }
    },
    routeCheck(body) {
      const req = body as {
        route: { coordinates: LonLat[] };
        xteLimit?: number;
        departure?: string;
        speed?: number;
        vessel?: { airHeight?: number };
      };
      const coords = req.route.coordinates;
      const r = widthFor(req.xteLimit);
      const speed = req.speed ?? 3;
      let at = req.departure ? Date.parse(req.departure) : 0;
      const legs = coords.slice(1).map((b, i) => {
        const a = coords[i] as LonLat;
        // Each leg at the water level while the boat is on it.
        const start = at;
        at += (haversine(a, b) / speed) * 1000;
        const air = airOver(req.vessel?.airHeight, { start, end: at });
        const v = legVerdict(chart, a, b, r, lowest(chart, { start, end: at }), air);
        const status = v.status;
        return {
          index: i,
          status,
          risk: status === "fail" ? 0.9 : v.risk,
          flags: v.flags,
          length: Math.round(haversine(a, b))
        };
      });
      const reply: Reply = { status: 200, body: { checkedAt: "t", legs } };
      return Promise.resolve(reply);
    },
    ...over
  };
  return api;
}
