import type { LonLat } from "../foundation/geo";
import { grownBox, grownBoxKm2 } from "../foundation/geo";
import type { Session } from "../oracle/contract";
import type { PassRule } from "./passes";
import { passes } from "./passes";
import { fieldOf } from "./field";
import type { QuadNode, QuadTree } from "./quadtree";
import { MAX_BOX_KM2 } from "./quadtree";

/**
 * Narrow water (plan §4.1 step 14): the search runs at the harbour corridor, and water only that
 * corridor passes, not the request's, costs `weight` more per metre, unless it lies on a charted
 * line (a fairway's navigation line, a leading line or a recommended track): there a corridor
 * narrower than the request's is the way the fairway is laid out. A square is wide when its box
 * grown by `margin`, the request's corridor less the harbour's, passes at the harbour corridor:
 * every point in it then has the request's corridor around it. Off the lines, the route keeps the
 * request's corridor wherever that costs less than the narrow water it would cross.
 */
export interface Narrow {
  /** Per-metre cost added in water only the narrow corridor passes. */
  weight: number;
  /** The request's corridor less the session's, metres. */
  margin: number;
  /** Whether the request's corridor passes every point of square `n`. */
  wide(n: QuadNode): boolean;
  /** Whether square `n` lies on a charted line, where narrow water costs nothing more. */
  fairway(n: QuadNode): boolean;
}

/** The narrow-water pricing for a search in `session` over `tree`. */
export function narrowIn(
  tree: QuadTree,
  session: Session,
  rule: PassRule,
  c: { margin: number; weight: number; fairway?: (n: QuadNode) => boolean }
): Narrow {
  const seen = new Map<number, boolean>();
  const onLine = new Map<number, boolean>();
  const { fairway } = c;
  const field = fieldOf(session, rule);
  return {
    weight: c.weight,
    margin: c.margin,
    // A square's place against the lines does not change: told once.
    fairway: fairway
      ? (n) => {
          let on = onLine.get(n.id);
          if (on === undefined) {
            on = fairway(n);
            onLine.set(n.id, on);
          }
          return on;
        }
      : () => false,
    wide(n) {
      let w = seen.get(n.id);
      if (w === undefined) {
        const [w0, s0, e0, n0] = grownBox(
          tree.lonLat(n.x, n.y),
          tree.lonLat(n.x + n.size, n.y + n.size),
          c.margin
        );
        const sw: LonLat = [w0, s0];
        const ne: LonLat = [e0, n0];
        // A box the planning API would refuse is not asked: it counts as narrow.
        w =
          grownBoxKm2(sw, ne, session.halfWidth) <= MAX_BOX_KM2 &&
          (field?.box(sw, ne) ?? passes(session.box(sw, ne), rule));
        seen.set(n.id, w);
      }
      return w;
    }
  };
}

/** Whether a free square should be split to find its wide part: narrow and larger than `margin`. */
export const splitsNarrow = (nar: Narrow, n: QuadNode, unit: number): boolean =>
  n.size * unit > nar.margin && !nar.wide(n);

/** The cost added per metre in square `n` by narrow water: 0 where it is wide or on a line. */
export const narrowCost = (nar: Narrow, n: QuadNode): number =>
  n.state === "free" && (nar.fairway(n) || nar.wide(n)) ? 0 : nar.weight;

type XY = [number, number];

/** The stretch of segment a–b inside square `n` (Liang–Barsky), as [t0, t1] along it; none when it misses. */
function span(n: Pick<QuadNode, "x" | "y" | "size">, a: XY, b: XY): [number, number] | undefined {
  const d: XY = [b[0] - a[0], b[1] - a[1]];
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-d[0], a[0] - n.x],
    [d[0], n.x + n.size - a[0]],
    [-d[1], a[1] - n.y],
    [d[1], n.y + n.size - a[1]]
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) {
        return undefined;
      }
      continue;
    }
    const r = q / p;
    if (p < 0) {
      t0 = Math.max(t0, r);
    } else {
      t1 = Math.min(t1, r);
    }
    if (t0 > t1) {
      return undefined;
    }
  }
  return [t0, t1];
}

/** Length of segment a–b inside square `n`, units; 0 when it misses. */
export function inside(n: Pick<QuadNode, "x" | "y" | "size">, a: XY, b: XY): number {
  const s = span(n, a, b);
  return s ? (s[1] - s[0]) * Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
}

/**
 * The total length of `spans` along a leg, each stretch once: a leg along the edge two squares
 * share lies in both.
 */
function covered(spans: [number, number][]): number {
  let total = 0;
  let reached = 0;
  for (const [t0, t1] of [...spans].sort((p, q) => p[0] - q[0])) {
    const from = Math.max(t0, reached);
    if (t1 > from) {
      total += t1 - from;
      reached = t1;
    }
  }
  return total;
}

/**
 * The share of leg a–b, 0 to 1, in squares the request's corridor does not pass: narrow water,
 * or a square not free. The squares along it are classified and priced as needed, until `stop`
 * holds.
 */
export function narrowShare(
  nar: Narrow,
  tree: QuadTree,
  a: LonLat,
  b: LonLat,
  stop: () => boolean = () => false
): number {
  const ua = tree.units(a);
  const ub = tree.units(b);
  const len = Math.hypot(ub[0] - ua[0], ub[1] - ua[1]);
  if (len === 0) {
    return 0;
  }
  const spans = tree
    .leaves((q) => inside(q, ua, ub) > 0, true, stop)
    .filter((n) => !stop() && narrowCost(nar, n) > 0)
    .map((n) => span(n, ua, ub))
    .filter((s) => s !== undefined);
  return Math.min(1, covered(spans));
}
