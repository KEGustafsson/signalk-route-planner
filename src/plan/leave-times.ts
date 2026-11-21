import { SLOT_MS } from "./gate";

/** A time the boat leaves a place at, and how it got there. */
export interface Leave {
  leave: number;
  arrive: number;
  /** The leave at the place before, by index into that place's list; -1 at the start. */
  from: number;
  /** The departure the boat left the start at: a later one waits less at sea. */
  departure: number;
}

/**
 * Times built up leg by leg are sums of floating-point sailing times: a leg meant to start on a
 * slot boundary can land a few microseconds before it, in the slot before. A leave time chosen
 * to bring a leg onto a boundary is tried as it is and this much later, so one of them starts
 * the leg after it, while a leg that exactly fills its slot still fits it.
 */
const PAST_BOUNDARY_MS = 1;

/**
 * The times after `first` and up to `last` to leave a place at that bring a gated leg `ahead`
 * (sailing times from the place) onto a slot boundary: on it, and just past it.
 */
export function leaveTimes(
  first: number,
  last: number,
  origin: number,
  ahead: readonly number[]
): number[] {
  const times = new Set<number>();
  for (const d of ahead) {
    for (let k = Math.floor((first + d - origin) / SLOT_MS) + 1; ; k++) {
      const on = origin + k * SLOT_MS - d;
      if (on > last) {
        break;
      }
      for (const t of d > 0 ? [on, on + PAST_BOUNDARY_MS] : [on]) {
        if (t > first && t <= last) {
          times.add(t);
        }
      }
    }
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Adds to `here` (arrivals, earliest first) leaving at each of `leaveTimes` after one and the
 * detour to the place and back, `detour` ms, and as soon as the boat is back from the detour.
 */
export function waitsAfter(
  here: Leave[],
  last: number,
  origin: number,
  ahead: readonly number[],
  detour: number
): void {
  const direct = new Set(here.map((l) => l.leave));
  const back = detour > 0 ? here.map((l) => l.arrive + detour).filter((t) => t <= last) : [];
  const times = [
    ...new Set([...leaveTimes((here[0] as Leave).arrive + detour, last, origin, ahead), ...back])
  ]
    .filter((t) => !direct.has(t))
    .sort((a, b) => a - b);
  const n = here.length;
  let best: Leave | undefined;
  let next = 0;
  for (const t of times) {
    while (next < n && (here[next] as Leave).arrive + detour <= t) {
      const a = here[next] as Leave;
      if (!best || a.departure > best.departure) {
        best = a;
      }
      next++;
    }
    if (best) {
      here.push({ ...best, leave: t });
    }
  }
}
