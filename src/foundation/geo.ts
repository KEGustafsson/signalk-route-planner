/** WGS84 longitude, latitude in degrees. */
export type LonLat = [number, number];

/** Mean earth radius, metres, as signalk-underkeel uses. */
export const EARTH_RADIUS = 6371008.8;

const DEG = Math.PI / 180;

/** Longitude in [-180, 180). */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Ground distance in metres between two points (haversine). */
export function haversine(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Local east/north metres around an origin. Both directions use the same
 * sphere, so a point mapped out and back is the point it came from;
 * longitudes are taken the short way round from the origin.
 */
export interface Frame {
  origin: LonLat;
  toXY(p: LonLat): [number, number];
  toLonLat(x: number, y: number): LonLat;
}

export function frameAt(origin: LonLat): Frame {
  const cos = Math.cos(origin[1] * DEG);
  return {
    origin,
    toXY: (p) => [
      wrapLon(p[0] - origin[0]) * DEG * EARTH_RADIUS * cos,
      (p[1] - origin[1]) * DEG * EARTH_RADIUS
    ],
    toLonLat: (x, y) => [
      wrapLon(origin[0] + x / (DEG * EARTH_RADIUS * cos)),
      origin[1] + y / (DEG * EARTH_RADIUS)
    ]
  };
}

/** The point midway between a and b, the short way round. */
export function midpoint(a: LonLat, b: LonLat): LonLat {
  return [wrapLon(a[0] + wrapLon(b[0] - a[0]) / 2), (a[1] + b[1]) / 2];
}

/**
 * The box `sw`–`ne` grown by `r` metres on every side, [west, south, east, north]: north and
 * south by `r`, east and west by `r` at its poleward edge, so it holds every point within `r`.
 */
export function grownBox(sw: LonLat, ne: LonLat, r: number): [number, number, number, number] {
  const dLat = r / (EARTH_RADIUS * DEG);
  const s = sw[1] - dLat;
  const n = ne[1] + dLat;
  const poleward = Math.cos(Math.max(Math.abs(s), Math.abs(n)) * DEG);
  const dLon = r / (EARTH_RADIUS * DEG * Math.max(poleward, 1e-6));
  return [sw[0] - dLon, s, ne[0] + dLon, n];
}

/**
 * How much of `box` the boxes `parts` cover, 0 to 1, by area in degrees; `parts` must not
 * overlap (a corridor's do not).
 */
export function coveredShare(
  box: readonly [number, number, number, number],
  parts: readonly (readonly [number, number, number, number])[]
): number {
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  if (area <= 0) {
    return 0;
  }
  let inside = 0;
  for (const p of parts) {
    const w = Math.min(box[2], p[2]) - Math.max(box[0], p[0]);
    const h = Math.min(box[3], p[3]) - Math.max(box[1], p[1]);
    if (w > 0 && h > 0) {
      inside += w * h;
    }
  }
  return Math.min(1, inside / area);
}

/**
 * An upper bound, km², on the area of the box sw–ne grown by `r` metres on every side,
 * as signalk-underkeel's planning API v1 grows and measures it (`grownBox`): its longitude
 * buffer is taken at the box's poleward edge, and its width here at the edge nearest the
 * equator, where it is widest.
 */
export function grownBoxKm2(sw: LonLat, ne: LonLat, r: number): number {
  const [w, s, e, n] = grownBox(sw, ne, r);
  const wide = s > 0 ? s : n < 0 ? n : 0;
  const width = (e - w) * DEG * EARTH_RADIUS * Math.cos(wide * DEG);
  return (width * (n - s) * DEG * EARTH_RADIUS) / 1e6;
}
