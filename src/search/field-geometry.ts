import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, haversine } from "../foundation/geo";

/**
 * The geometry of a leg's and a box's verdict on the chart's tile grid, for `field.ts`: where
 * signalk-underkeel's corridor of a leg lies in cells, and how far a cell is from it.
 */

const DEG = Math.PI / 180;
/** Web Mercator's sphere, metres: a cell at zoom z is 2π · this / 2^z across on the chart. */
const MERCATOR_RADIUS = 6378137;
/** Web Mercator's latitude limit, degrees. */
const MAX_LAT = 85.05112878;
/** Past this latitude, degrees, nothing is settled here: a cell's ground size changes too fast. */
const MAX_FIELD_LAT = 80;
/**
 * signalk-underkeel lays a corridor out on the WGS84 ellipsoid and widens each ring by 1/256:
 * on the Mercator chart a ground metre is at most this much longer than on the sphere, and at
 * least `NARROW` of it.
 */
export const WIDE = 1.012;
const NARROW = 0.99;
/** Added to a corridor that must hold every tile counted, and half of it taken off one that must lie inside it, metres. */
const SLACK_M = 0.5;
/**
 * A leg whose great circle bows this far from its rhumb line, metres, is checked along both
 * (signalk-underkeel's `legCorridors`): it is asked of `segment`.
 */
const MAX_BOW_M = 10;
/** A leg whose bow is at most this, metres, by `bowBound`, is not measured: the bound serves. */
const SMALL_BOW_M = 0.05;
/** A corridor ring's corners lie this many half-widths from its leg's end (underkeel's RING_REACH). */
const RING_REACH = Math.SQRT2 * (1 + 1 / 256);

/** A cell's side on the chart at zoom `z`, Mercator metres. */
export const cellSide = (z: number): number => (2 * Math.PI * MERCATOR_RADIUS) / 2 ** z;

/** `p` in cells of a grid `n` cells across, from the north-west corner of the world, y southward. */
export function cellsOf(p: LonLat, n: number): [number, number] {
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p[1])) * DEG;
  return [((p[0] + 180) / 360) * n, ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * n];
}

/** Distance from point (px, py) to the segment (ax, ay)–(bx, by). */
function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Distance from point (px, py) to the unit square whose low corner is (x, y); 0 inside it. */
function toSquare(px: number, py: number, x: number, y: number): number {
  return Math.hypot(Math.max(x - px, 0, px - x - 1), Math.max(y - py, 0, py - y - 1));
}

/** A segment in cells: x and y of its two ends. */
export type Segment = readonly [number, number, number, number];

/** Whether segment `s` meets the unit square at (x, y) (Liang–Barsky). */
function crosses(s: Segment, x: number, y: number): boolean {
  const [ax, ay, bx, by] = s;
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - x, x + 1 - ax, ay - y, y + 1 - ay];
  for (let k = 0; k < 4; k++) {
    const pk = p[k] as number;
    const qk = q[k] as number;
    if (pk === 0) {
      if (qk < 0) {
        return false;
      }
    } else if (pk < 0) {
      t0 = Math.max(t0, qk / pk);
    } else {
      t1 = Math.min(t1, qk / pk);
    }
  }
  return t0 <= t1;
}

/** Distance from segment `s` to the unit square at (x, y), cells; 0 where they meet. */
export function segmentToSquare(s: Segment, x: number, y: number): number {
  if (crosses(s, x, y)) {
    return 0;
  }
  const [ax, ay, bx, by] = s;
  return Math.min(
    toSquare(ax, ay, x, y),
    toSquare(bx, by, x, y),
    toSegment(x, y, ax, ay, bx, by),
    toSegment(x + 1, y, ax, ay, bx, by),
    toSegment(x, y + 1, ax, ay, bx, by),
    toSegment(x + 1, y + 1, ax, ay, bx, by)
  );
}

/**
 * The columns the cells within `hold` of segment `s` lie in, in row `y`: the part of the
 * segment within `hold` of the row, north to south, and its span east–west grown by `hold`.
 */
export function rowSpan(s: Segment, y: number, hold: number): [number, number] {
  const [px, py, qx, qy] = s;
  let x0 = Math.min(px, qx);
  let x1 = Math.max(px, qx);
  if (qy !== py) {
    const t0 = Math.max(0, Math.min(1, (y - hold - py) / (qy - py)));
    const t1 = Math.max(0, Math.min(1, (y + 1 + hold - py) / (qy - py)));
    const xa = px + (qx - px) * t0;
    const xb = px + (qx - px) * t1;
    x0 = Math.min(xa, xb);
    x1 = Math.max(xa, xb);
  }
  return [Math.floor(x0 - hold), Math.floor(x1 + hold)];
}

/** `p` on the Mercator chart, metres. */
function mercator(p: LonLat): [number, number] {
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p[1])) * DEG;
  return [MERCATOR_RADIUS * p[0] * DEG, MERCATOR_RADIUS * Math.asinh(Math.tan(lat))];
}

function unit(p: LonLat): [number, number, number] {
  const c = Math.cos(p[1] * DEG);
  return [c * Math.cos(p[0] * DEG), c * Math.sin(p[0] * DEG), Math.sin(p[1] * DEG)];
}

/**
 * The gap between the leg's rhumb line and its great circle as signalk-underkeel measures it
 * (`greatCircleOffset`): the widest of seven points as far along each. A leg's corridor is
 * widened by it.
 */
export function bowOf(a: LonLat, b: LonLat): number {
  const [ax, ay] = mercator(a);
  const [bx, by] = mercator(b);
  const va = unit(a);
  const vb = unit(b);
  const omega = Math.acos(Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  if (omega === 0) {
    return 0;
  }
  let gap = 0;
  for (let i = 1; i < 8; i++) {
    const t = i / 8;
    const rhumb: LonLat = [
      (ax + (bx - ax) * t) / MERCATOR_RADIUS / DEG,
      (2 * Math.atan(Math.exp((ay + (by - ay) * t) / MERCATOR_RADIUS)) - Math.PI / 2) / DEG
    ];
    const wa = Math.sin((1 - t) * omega) / Math.sin(omega);
    const wb = Math.sin(t * omega) / Math.sin(omega);
    const [x, y, z] = [0, 1, 2].map((k) => wa * (va[k] as number) + wb * (vb[k] as number)) as [
      number,
      number,
      number
    ];
    const great: LonLat = [Math.atan2(y, x) / DEG, Math.atan2(z, Math.hypot(x, y)) / DEG];
    gap = Math.max(gap, haversine(rhumb, great));
  }
  return gap;
}

/** An upper bound of `bowOf` for a leg `length` metres long reaching latitude `lat`, degrees. */
const bowBound = (length: number, lat: number): number =>
  (1.05 * length * length * Math.tan(lat * DEG)) / (8 * EARTH_RADIUS) + 0.01;

/** The latitudes a pair of points reaches: the highest, and the lowest (0 across the equator). */
function latitudes(a: LonLat, b: LonLat): { high: number; low: number } {
  return {
    high: Math.max(Math.abs(a[1]), Math.abs(b[1])),
    low: a[1] * b[1] <= 0 ? 0 : Math.min(Math.abs(a[1]), Math.abs(b[1]))
  };
}

/** A leg's corridor on a grid of cells, as `Field` tests it. */
export interface LegCorridor {
  /** The leg in cells, and the leg drawn on past both ends by `half`. */
  leg: Segment;
  long: Segment;
  /** Every tile of the corridor lies within this of `long`, cells. */
  half: number;
  /** A cell within this of `leg` lies in the corridor, cells; not positive when none surely does. */
  inside: number;
  /** The smallest ground size of a cell along the leg, metres. */
  small: number;
}

/**
 * The corridor of the leg a → b, `r` metres to each side, on a grid `n` cells across whose
 * cells are `cell` Mercator metres: signalk-underkeel checks a rectangle around the leg, `r`
 * and the leg's bow to each side and past each end. Undefined for a leg the field does not
 * settle: near a pole, a quarter of the way round the world, or bowed enough to be checked
 * along its great circle too.
 */
export function legCorridor(
  a: LonLat,
  b: LonLat,
  r: number,
  grid: { n: number; cell: number }
): LegCorridor | undefined {
  const { high, low } = latitudes(a, b);
  if (high > MAX_FIELD_LAT || Math.abs(b[0] - a[0]) > 90) {
    return undefined;
  }
  // The bow as underkeel measures it, or for a short leg its bound, which widens what must be
  // held and narrows nothing.
  const bound = bowBound(haversine(a, b), high);
  const measured = bound > SMALL_BOW_M;
  const bow = measured ? bowOf(a, b) * 1.001 + 0.001 : bound;
  const least = measured ? bow * 0.998 - 0.002 : 0;
  if (bow > MAX_BOW_M) {
    return undefined;
  }
  // Ground metres to cells: the smallest cell there is for what must be held, the largest for
  // what must lie inside.
  const small = grid.cell * Math.cos((high + 0.05) * DEG);
  const large = grid.cell * Math.cos(low * DEG);
  const [ax, ay] = cellsOf(a, grid.n);
  const [bx, by] = cellsOf(b, grid.n);
  const half = ((r + bow) * WIDE + SLACK_M) / small;
  const len = Math.hypot(bx - ax, by - ay);
  const ex = len > 0 ? ((bx - ax) / len) * half : 0;
  const ey = len > 0 ? ((by - ay) / len) * half : 0;
  return {
    leg: [ax, ay, bx, by],
    long: [ax - ex, ay - ey, bx + ex, by + ey],
    half,
    inside: ((r + least) * NARROW - SLACK_M / 2) / large,
    small
  };
}

/** A box's verdict ring on a grid of cells: the box, and how far past it tiles count. */
export interface BoxCorridor {
  /** West, north, east and south edges of the box, cells. */
  box: Segment;
  /** Every tile of the verdict's ring lies within this of the box, cells. */
  grow: number;
  small: number;
}

/**
 * The ring of the box sw–ne's verdict at a corridor `r` metres wide: the box grown by the reach
 * of a corridor ring past its leg's end and the bulge of a leg across it (underkeel's
 * `grownBox`). Undefined for a box the field does not settle.
 */
export function boxCorridor(
  sw: LonLat,
  ne: LonLat,
  r: number,
  grid: { n: number; cell: number }
): BoxCorridor | undefined {
  const { high } = latitudes(sw, ne);
  if (high > MAX_FIELD_LAT || sw[0] > ne[0] || ne[0] - sw[0] > 90) {
    return undefined;
  }
  const small = grid.cell * Math.cos((high + 0.05) * DEG);
  const bulge = (2 * haversine(sw, ne) ** 2 * Math.tan(high * DEG)) / (8 * EARTH_RADIUS) + 1;
  const [x0, y1] = cellsOf(sw, grid.n);
  const [x1, y0] = cellsOf(ne, grid.n);
  return {
    box: [x0, y0, x1, y1],
    grow: ((r * RING_REACH + bulge) * WIDE + SLACK_M) / small,
    small
  };
}
