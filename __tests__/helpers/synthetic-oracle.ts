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
  obstacles: Circle[];
  unverified?: Circle[];
  /** Corridor half-width, metres. */
  halfWidth?: number;
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

function verdict(status: Status): Verdict {
  return {
    status,
    risk: status === "fail" ? 0.9 : 0,
    flags: status === "unverified" ? ["NO_COVERAGE"] : []
  };
}

/** The status of the leg a → b on `chart` with corridor half-width r. */
export function legStatus(chart: Chart, a: LonLat, b: LonLat, r: number): Status {
  const pa = xy(a);
  const pb = xy(b);
  if (chart.obstacles.some((c) => segDist(c.x, c.y, pa, pb) < c.r + r)) {
    return "fail";
  }
  if ((chart.unverified ?? []).some((c) => segDist(c.x, c.y, pa, pb) < c.r + r)) {
    return "unverified";
  }
  return "ok";
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
  const r = chart.halfWidth ?? 40;
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
      let work = 0;
      const session: Session = {
        halfWidth: r,
        box(sw, ne) {
          work += per;
          api.boxes++;
          const corners = [sw, ne, [sw[0], ne[1]] as LonLat, [ne[0], sw[1]] as LonLat].map(xy);
          const x0 = Math.min(...corners.map((c) => c[0]));
          const x1 = Math.max(...corners.map((c) => c[0]));
          const y0 = Math.min(...corners.map((c) => c[1]));
          const y1 = Math.max(...corners.map((c) => c[1]));
          const hits = (cs: Circle[]) =>
            cs.some((c) => rectDist(c.x, c.y, x0, y0, x1, y1) < c.r + r);
          return verdict(
            hits(chart.obstacles) ? "fail" : hits(chart.unverified ?? []) ? "unverified" : "ok"
          );
        },
        segment(a, b) {
          work += per;
          return verdict(legStatus(chart, a, b, r));
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
      const coords = (body as { route: { coordinates: LonLat[] } }).route.coordinates;
      const legs = coords.slice(1).map((b, i) => {
        const a = coords[i] as LonLat;
        const status = legStatus(chart, a, b, r);
        return {
          index: i,
          status,
          risk: status === "fail" ? 0.9 : 0,
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
