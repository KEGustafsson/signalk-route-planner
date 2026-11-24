import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { Part, Staged } from "./stages";

/**
 * A second look at a route's ends (plan §4.1). Each search lays its grid of squares by its own
 * trip, and a harbour stage hands over to the free water nearest the end on that grid. From
 * Parainen to Stenskär the destination's handover fell south-west of the sound by Korsskär,
 * which the main search's grid had closed, and the route went round by Spåharu sund, 1.9 km
 * longer than a plan of the last 3.3 km alone takes; moving the start 5 m opened the sound.
 * So where the route's last LOOK metres, as the crow flies, run more than DETOUR times that far,
 * that stretch is planned again as a trip of its own, with its own grid and handovers, and kept
 * when its price is lower; likewise the first LOOK metres. The proof checks the route as
 * always (invariant 1).
 */

/** How far from an end, straight, the stretch looked at again starts, metres. */
export const LOOK = 3000;
/** A stretch this many times longer than the straight line is looked at again. */
export const DETOUR = 1.25;

const lengthOf = (c: readonly LonLat[]): number =>
  c.slice(1).reduce((s, b, i) => s + haversine(c[i] as LonLat, b), 0);

/** A stretch's price as the search prices it: its length, and narrow water at `narrow` more. */
export function priceOf(parts: readonly Part[], narrow: number): number {
  return parts.reduce(
    (s, p) => s + lengthOf(p.coordinates) * (p.kind === "narrows" ? 1 + narrow : 1),
    0
  );
}

/** `parts` up to their point `at`, a vertex of theirs, and from it on. */
export function cutAt(parts: readonly Part[], at: LonLat): [Part[], Part[]] {
  for (let k = 0; k < parts.length; k++) {
    const c = (parts[k] as Part).coordinates;
    const i = c.findIndex((p) => p[0] === at[0] && p[1] === at[1]);
    if (i >= 0) {
      const head = [
        ...parts.slice(0, k),
        { ...(parts[k] as Part), coordinates: c.slice(0, i + 1) }
      ];
      const tail = [{ ...(parts[k] as Part), coordinates: c.slice(i) }, ...parts.slice(k + 1)];
      const long = (p: Part): boolean => p.coordinates.length > 1;
      return [head.filter(long), tail.filter(long)];
    }
  }
  return [[...parts], []];
}

/** Whether any part is a lowest risk-weighted one: water no route passes. */
const fallen = (parts: readonly Part[]): boolean => parts.some((p) => p.fallback !== undefined);

type Found = Extract<Staged, { ok: true }>;

/**
 * `found` with its stretch from `at` to the end (`end` "end") or from its start to `at` ("start")
 * replaced by `again`, a plan of that stretch alone, when that is cheaper and crosses no water
 * that does not pass where the stretch it replaces crossed none.
 */
function spliced(
  found: Found,
  again: Found,
  at: LonLat,
  end: "start" | "end",
  narrow: number
): Found {
  const [head, tail] = cutAt(found.parts, at);
  const old = end === "end" ? tail : head;
  if (fallen(again.parts) && !fallen(old)) {
    return found;
  }
  if (priceOf(again.parts, narrow) >= priceOf(old, narrow) - 1) {
    return found;
  }
  return {
    ...found,
    parts: end === "end" ? [...head, ...again.parts] : [...again.parts, ...tail],
    work: found.work + again.work,
    squares: found.squares + again.squares
  };
}

/**
 * The vertex of `path` the stretch at `end` is looked at again from: the last one, counted from
 * that end, at least LOOK metres from it straight. Undefined when there is none, or the stretch
 * runs no more than DETOUR times the straight line.
 */
export function lookFrom(path: readonly LonLat[], end: "start" | "end"): LonLat | undefined {
  const pts = end === "end" ? [...path].reverse() : [...path];
  const tip = pts[0] as LonLat;
  const i = pts.findIndex((p) => haversine(p, tip) >= LOOK);
  if (i <= 1) {
    return undefined;
  }
  const at = pts[i] as LonLat;
  return lengthOf(pts.slice(0, i + 1)) > DETOUR * haversine(at, tip) ? at : undefined;
}

/**
 * `found` after a second look at each end: `plan` plans a stretch of the route as a trip of its
 * own on the work left; the cheaper of the two ways stands.
 */
export async function secondLook(
  found: Staged,
  plan: (a: LonLat, b: LonLat, maxWork: number) => Promise<Staged>,
  c: { maxWork: number; narrow: number }
): Promise<Staged> {
  if (!found.ok) {
    return found;
  }
  let out: Found = found;
  for (const end of ["end", "start"] as const) {
    const path = out.parts.flatMap((p) => p.coordinates);
    const at = lookFrom(path, end);
    const left = c.maxWork - out.work;
    if (!at || left <= 0) {
      continue;
    }
    const first = path[0] as LonLat;
    const last = path[path.length - 1] as LonLat;
    const again = await plan(end === "end" ? at : first, end === "end" ? last : at, left);
    if (again.ok) {
      out = spliced(out, again, at, end, c.narrow);
    } else if (!("refusal" in again)) {
      // The provider failed: answered as it answered, never with half a look.
      return again;
    }
  }
  return out;
}
