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
 * An upper bound, km², on the area of the box sw–ne grown by `r` metres on every side,
 * as signalk-underkeel's planning API v1 grows and measures it (`grownBox`): its longitude
 * buffer is taken at the box's poleward edge, and its width here at the edge nearest the
 * equator, where it is widest.
 */
export function grownBoxKm2(sw: LonLat, ne: LonLat, r: number): number {
  const dLat = r / (EARTH_RADIUS * DEG);
  const s = sw[1] - dLat;
  const n = ne[1] + dLat;
  const poleward = Math.cos(Math.max(Math.abs(s), Math.abs(n)) * DEG);
  const dLon = r / (EARTH_RADIUS * DEG * Math.max(poleward, 1e-6));
  const wide = s > 0 ? s : n < 0 ? n : 0;
  const width = (ne[0] - sw[0] + 2 * dLon) * DEG * EARTH_RADIUS * Math.cos(wide * DEG);
  return (width * (n - s) * DEG * EARTH_RADIUS) / 1e6;
}
