import type { LonLat } from "../../src/foundation/geo";
import { haversine } from "../../src/foundation/geo";
import type { PlanningApiV1, Raster, Reply, Session, Verdict } from "../../src/oracle/contract";
import { RASTER } from "../../src/oracle/contract";
import type { Segment } from "../../src/search/field-geometry";
import { cellsOf, segmentToSquare } from "../../src/search/field-geometry";

/**
 * A planning API over a chart of land tiles, for tests of the raster field: as
 * signalk-underkeel's index, the chart is its finest tiles, and a leg or a box fails where a
 * land tile lies within its corridor. With `raster`, its sessions serve the raster of those
 * tiles; without, the same verdicts and no raster, so a plan made either way can be compared.
 */

export const TILE_ZOOM = 20;
const N = 2 ** TILE_ZOOM;

/** The north-west tile of the test area, near 60° N 22° E. */
const [OX, OY] = cellsOf([22, 60], N).map(Math.floor) as [number, number];

/** The point at tile coordinates (x, y) from the test area's corner, y southward. */
export function tileAt(x: number, y: number): LonLat {
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (OY + y)) / N)));
  return [((OX + x) / N) * 360 - 180, (lat * 180) / Math.PI];
}

/** A tile's ground size at the test area, metres. */
export const TILE_M = haversine(tileAt(0, 0), tileAt(1, 0));

const LAND_BYTE = 2 | RASTER.RISKY | RASTER.STUCK;
const FAIL: Verdict = { status: "fail", risk: 0.9, flags: ["LAND"] };
const OK: Verdict = { status: "ok", risk: 0, flags: [] };

export interface Tiled extends PlanningApiV1 {
  /** Legs and boxes asked of the chart, and raster blocks read. */
  asked: { legs: number; boxes: number; blocks: number };
}

/** The tiles of a disc of `radius` tiles about tile (cx, cy). */
export function disc(cx: number, cy: number, radius: number): [number, number][] {
  const out: [number, number][] = [];
  for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
    for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) {
        out.push([x, y]);
      }
    }
  }
  return out;
}

export function tiledApi(land: readonly [number, number][], raster: boolean): Tiled {
  const key = (x: number, y: number): number => y * 65_536 + x;
  const set = new Set(land.map(([x, y]) => key(x, y)));
  const cells = (p: LonLat): [number, number] => {
    const [x, y] = cellsOf(p, N);
    return [x - OX, y - OY];
  };
  // As signalk-underkeel: the corridor half-width is the cross-track limit plus a 10 m buffer.
  const widthFor = (xteLimit: number | undefined): number =>
    xteLimit !== undefined ? xteLimit + 10 : 40;
  /** Whether a land tile lies within `r` tiles of segment `s`. */
  const near = (s: Segment, r: number): boolean =>
    land.some(([x, y]) => {
      const out =
        x + 1 < Math.min(s[0], s[2]) - r ||
        x > Math.max(s[0], s[2]) + r ||
        y + 1 < Math.min(s[1], s[3]) - r ||
        y > Math.max(s[1], s[3]) + r;
      return !out && segmentToSquare(s, x, y) < r;
    });
  const leg = (a: LonLat, b: LonLat, r: number): Verdict =>
    near([...cells(a), ...cells(b)], r / TILE_M) ? FAIL : OK;
  const api: Tiled = {
    version: 1,
    provider: "tiled",
    asked: { legs: 0, boxes: 0, blocks: 0 },
    unavailable: () => undefined,
    coverage: () => undefined,
    defaults: () => ({ speed: 3, xteLimit: 30, probability: 0.01, planningBuffer: 10 }),
    async session(params, signal, job) {
      const r = widthFor(params.xteLimit);
      let work = 0;
      const session: Session = {
        halfWidth: r,
        box(sw, ne) {
          work += 100;
          api.asked.boxes++;
          const [x0, y1] = cells(sw);
          const [x1, y0] = cells(ne);
          const g = r / TILE_M;
          const hit = land.some(
            ([x, y]) => x + 1 > x0 - g && x < x1 + g && y + 1 > y0 - g && y < y1 + g
          );
          return hit ? FAIL : OK;
        },
        segment(a, b) {
          work += 100;
          api.asked.legs++;
          return leg(a, b, r);
        },
        work: () => work,
        pause: () =>
          new Promise((resolve, reject) =>
            setImmediate(() => (signal.aborted ? reject(signal.reason) : resolve()))
          ),
        ...(raster && {
          rasterZoom: TILE_ZOOM,
          raster(x0: number, y0: number, cols: number, rows: number): Raster {
            api.asked.blocks++;
            work += 10;
            const bytes = new Uint8Array(cols * rows);
            const flags = new Uint8Array(cols * rows);
            for (let j = 0; j < rows; j++) {
              for (let i = 0; i < cols; i++) {
                if (set.has(key(x0 + i - OX, y0 + j - OY))) {
                  bytes[j * cols + i] = LAND_BYTE;
                  flags[j * cols + i] = 1;
                }
              }
            }
            return {
              z: TILE_ZOOM,
              x0,
              y0,
              cols,
              rows,
              cells: bytes,
              flags,
              flagSets: [[], ["LAND"]],
              reach: 0
            };
          }
        })
      };
      return { ok: true, value: await job(session) };
    },
    routeCheck(body) {
      const req = body as { route: { coordinates: LonLat[] }; xteLimit?: number };
      const c = req.route.coordinates;
      const legs = c.slice(1).map((b, i) => {
        const v = leg(c[i] as LonLat, b, widthFor(req.xteLimit));
        return {
          index: i,
          status: v.status,
          risk: v.risk,
          flags: v.flags,
          length: Math.round(haversine(c[i] as LonLat, b))
        };
      });
      const reply: Reply = { status: 200, body: { checkedAt: "t", legs } };
      return Promise.resolve(reply);
    }
  };
  return api;
}
