import type { Session, Verdict, Window } from "../oracle/contract";

/**
 * A guide for the search (plan §6, steering): a coarse path from start to goal, and from it a
 * heuristic, the way to the goal along the path from the nearest point of it. A* ordered by it
 * goes along the likely way and round an island by the side the coarse path takes, instead of
 * flooding every bay the straight line points into. It only orders the search: every square is
 * still asked about and every leg checked, and a square far from the path can still be reached.
 */

type XY = [number, number];

export class Guide {
  /** The path's length from each vertex to the goal, units. */
  private readonly rest: number[];

  /**
   * `cost` per metre of each segment of the path, 1 when absent: the fallback's guide counts the
   * risk it will likely have to cross on the way, so it does not first try every cheap way that
   * still leads to that crossing.
   */
  constructor(
    readonly path: readonly XY[],
    private readonly cost: readonly number[] = []
  ) {
    this.rest = new Array<number>(path.length).fill(0);
    for (let i = path.length - 2; i >= 0; i--) {
      const [a, b] = [path[i] as XY, path[i + 1] as XY];
      this.rest[i] =
        (this.rest[i + 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]) * (cost[i] ?? 1);
    }
  }

  /**
   * The way from `p` to the goal: to the nearest point of the path, then along it. Never less
   * than the straight line to the goal; it overestimates where the path winds, which only makes
   * the search keep nearer the path. It changes by at most twice the distance `p` moves, save
   * where the nearest point jumps between two arms of the path.
   */
  to(p: XY): number {
    const n = this.path.length;
    let near = Infinity;
    let along = 0;
    for (let i = 0; i + 1 < n; i++) {
      const a = this.path[i] as XY;
      const b = this.path[i + 1] as XY;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t =
        len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
      const qx = a[0] + t * dx;
      const qy = a[1] + t * dy;
      const d = Math.hypot(p[0] - qx, p[1] - qy);
      if (d < near) {
        near = d;
        along =
          (this.rest[i + 1] as number) + Math.hypot(b[0] - qx, b[1] - qy) * (this.cost[i] ?? 1);
      }
    }
    if (n === 1) {
      const q = this.path[0] as XY;
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    }
    return near + along;
  }

  /** This guide from `start` along the path to `goal`: the squares the ends join may lie off it. */
  through(start: XY, goal: XY): Guide {
    return new Guide([start, ...this.path, goal], [1, ...this.cost, 1]);
  }
}

/**
 * `session` with its box verdicts kept: the coarse pass and the search ask about the same
 * squares, each once. A verdict is a function of the box and the window alone.
 */
export function memoBoxes(session: Session): Session {
  const seen = new Map<string, Verdict>();
  const box = (sw: [number, number], ne: [number, number], window?: Window): Verdict => {
    const key = `${sw[0]},${sw[1]},${ne[0]},${ne[1]}|${window ? `${window.start},${window.end}` : ""}`;
    let v = seen.get(key);
    if (v === undefined) {
      v = session.box(sw, ne, window);
      seen.set(key, v);
    }
    return v;
  };
  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === "box") {
        return box;
      }
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    }
  });
}
