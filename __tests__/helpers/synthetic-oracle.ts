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
  /** Land: fails and is never crossed (flag LAND). */
  obstacles: Circle[];
  /** Charted shallows: fail, but the fallback may cross them. */
  shallows?: Circle[];
  unverified?: Circle[];
  /** Water the check passes with a warning: marginal, at P(UKC < 0) 0.005. */
  marginal?: Circle[];
  /** Shallows that pass once the water level is at least `needs` metres: a tide gate. */
  tidal?: (Circle & { needs: number })[];
  /** The water level at time t, metres; 0 when absent. */
  tide?: (t: number) => number;
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

/** What water within `near` of the corridor gets: land, shallows, unverified or clear. */
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

function judge(chart: Chart, near: (c: Circle) => boolean, level = 0): Verdict {
  // A closed area's flag is reported with land's, as the route check reports every flag.
  const closed = (chart.closed ?? []).find(near);
  const rule = closed ? [closed.flag] : [];
  if (chart.obstacles.some(near)) {
    return { status: "fail", risk: 0.9, flags: ["LAND", ...rule] };
  }
  if (closed) {
    return { status: "fail", risk: 0, flags: rule };
  }
  if ((chart.tidal ?? []).some((c) => near(c) && level < c.needs)) {
    return { status: "fail", risk: 0.9, flags: [] };
  }
  if ((chart.shallows ?? []).some(near)) {
    return { status: "fail", risk: 0.9, flags: [] };
  }
  if ((chart.unverified ?? []).some(near)) {
    return { status: "unverified", risk: 0, flags: ["NO_COVERAGE"] };
  }
  if ((chart.marginal ?? []).some(near)) {
    return { status: "marginal", risk: 0.005, flags: [] };
  }
  return chart.notForNavigation
    ? { status: "unverified", risk: 0, flags: ["NOT_FOR_NAVIGATION"] }
    : { status: "ok", risk: 0, flags: [] };
}

/** The verdict of the leg a → b on `chart` with corridor half-width r. */
export function legVerdict(chart: Chart, a: LonLat, b: LonLat, r: number, level = 0): Verdict {
  const pa = xy(a);
  const pb = xy(b);
  return judge(chart, (c) => segDist(c.x, c.y, pa, pb) < c.r + r, level);
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
          return judge(chart, (c) => rectDist(c.x, c.y, x0, y0, x1, y1) < c.r + r, level);
        },
        segment(a, b, w) {
          // As signalk-underkeel: a leg's corridor over 25 km² is refused.
          if (((haversine(a, b) + 2 * r) * 2 * r) / 1e6 > 25) {
            throw new RangeError("leg corridor over 25 km²");
          }
          work += per;
          return legVerdict(chart, a, b, r, lowest(chart, w ?? whole));
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
        const v = legVerdict(chart, a, b, r, lowest(chart, { start, end: at }));
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
