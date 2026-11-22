import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { Session } from "../oracle/contract";
import { Heap } from "../search/heap";
import type { PassRule } from "../search/passes";
import { strictMode } from "./modes";
import { checkLeg } from "./search";

/**
 * The fairway stage (plan §4.1 step 15): the way along the charted navigation lines. A swept
 * fairway a few tens of metres wide is narrower than the squares of any search the work budget
 * allows, though a leg along its line passes; so the lines are searched as a graph of their own,
 * their points its nodes, each line's legs its edges, the start and destination joined to the
 * nearest points on them. Dijkstra finds the shortest way; each of its legs is checked through
 * the session, and a leg that does not pass leaves the graph until a way passes or none is left.
 * The route it gives is a candidate like the search's: the proof decides (invariant 1).
 */

/** Lines a fairway stage follows: a fairway's navigation line, a leading line, a recommended track. */
const FOLLOWED = new Set(["NAVLINE", "NAVLNE", "RECTRC"]);

/** Points of the lines nearest an end it is joined to, at most this many. */
const JOINS = 4;

/** Rounds of Dijkstra, each after removing the legs that did not pass, at most this many. */
const ROUNDS = 40;

interface Edge {
  to: number;
  length: number;
  key: string;
}

class Graph {
  readonly points: LonLat[] = [];
  readonly edges: Edge[][] = [];
  private readonly ids = new Map<string, number>();

  node(p: LonLat): number {
    const key = `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.points.length;
      this.ids.set(key, id);
      this.points.push(p);
      this.edges.push([]);
    }
    return id;
  }

  link(a: number, b: number): void {
    if (a === b) {
      return;
    }
    const length = haversine(this.points[a] as LonLat, this.points[b] as LonLat);
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    (this.edges[a] as Edge[]).push({ to: b, length, key });
    (this.edges[b] as Edge[]).push({ to: a, length, key });
  }
}

/** The point of segment a–b nearest p, in a local plane at p (short distances). */
function nearestOn(p: LonLat, a: LonLat, b: LonLat): LonLat {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * k;
  const ay = a[1] - p[1];
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** The lines' legs: consecutive points of each line the session lists in the box. */
function legsIn(
  session: Session,
  sw: LonLat,
  ne: LonLat,
  draft: number | undefined
): [LonLat, LonLat][] {
  let objects;
  try {
    objects = session.objects?.(sw, ne) ?? [];
  } catch (err) {
    // A region too large to list has no fairway stage: it only ever adds a candidate.
    if (err instanceof RangeError) {
      return [];
    }
    throw err;
  }
  const legs: [LonLat, LonLat][] = [];
  for (const o of objects) {
    const laidOut = o.designDraft === undefined || draft === undefined || o.designDraft >= draft;
    if (!FOLLOWED.has(o.class) || o.geometry.type !== "LineString" || !laidOut) {
      continue;
    }
    const c = o.geometry.coordinates as LonLat[];
    for (let i = 1; i < c.length; i++) {
      legs.push([c[i - 1] as LonLat, c[i] as LonLat]);
    }
  }
  return legs;
}

/** A line's point within this of another line's leg meets it there, metres. */
const SNAP = 5;

/**
 * Where the lines meet: a line's point within SNAP of another line's leg, by leg. Lines meet at
 * shared points, but a branch often ends on another line's leg between its points (a T), and
 * without that point on the leg the graph falls apart into the lines that happen to share one.
 */
function junctions(legs: [LonLat, LonLat][]): Map<number, LonLat[]> {
  const cuts = new Map<number, LonLat[]>();
  const pad = SNAP / 111_320;
  const boxes = legs.map(([a, b]) => {
    const k = pad / Math.max(Math.cos((a[1] * Math.PI) / 180), 1e-6);
    return [
      Math.min(a[0], b[0]) - k,
      Math.min(a[1], b[1]) - pad,
      Math.max(a[0], b[0]) + k,
      Math.max(a[1], b[1]) + pad
    ];
  });
  const same = (p: LonLat, q: LonLat): boolean => p[0] === q[0] && p[1] === q[1];
  legs.forEach((leg, i) => {
    for (const p of leg) {
      legs.forEach(([a, b], j) => {
        const [w, s, e, n] = boxes[j] as number[];
        if (j === i || same(p, a) || same(p, b) || p[0] < (w as number) || p[0] > (e as number)) {
          return;
        }
        if (p[1] < (s as number) || p[1] > (n as number)) {
          return;
        }
        if (haversine(p, nearestOn(p, a, b)) <= SNAP) {
          cuts.set(j, [...(cuts.get(j) ?? []), p]);
        }
      });
    }
  });
  return cuts;
}

/** The graph of `legs`, with `ends` joined to the nearest points on them within `reach` metres. */
function graphOf(legs: [LonLat, LonLat][], ends: [LonLat, LonLat], reach: number): Graph {
  const g = new Graph();
  const near = ends.map((e) =>
    legs
      .map(([a, b], i) => ({ i, at: nearestOn(e, a, b) }))
      .map((j) => ({ ...j, d: haversine(e, j.at) }))
      .filter((j) => j.d <= reach)
      .sort((x, y) => x.d - y.d)
      .slice(0, JOINS)
  );
  // Each leg with the points an end joins it at, and the lines meeting it, in order along it.
  const cuts = junctions(legs);
  for (const list of near) {
    for (const j of list) {
      cuts.set(j.i, [...(cuts.get(j.i) ?? []), j.at]);
    }
  }
  legs.forEach(([a, b], i) => {
    const along = (cuts.get(i) ?? []).sort((p, q) => haversine(a, p) - haversine(a, q));
    const chain = [a, ...along, b].map((p) => g.node(p));
    for (let k = 1; k < chain.length; k++) {
      g.link(chain[k - 1] as number, chain[k] as number);
    }
  });
  ends.forEach((e, k) => {
    const id = g.node(e);
    for (const j of near[k] ?? []) {
      g.link(id, g.node(j.at));
    }
  });
  return g;
}

/** The shortest way from `from` to `to` over edges not `closed`, as nodes; none when cut off. */
function shortest(g: Graph, from: number, to: number, closed: Set<string>): number[] | undefined {
  const dist = new Map<number, number>([[from, 0]]);
  const back = new Map<number, number>();
  const open = new Heap<number>();
  open.push(from, 0);
  const done = new Set<number>();
  while (open.size > 0) {
    const n = open.pop();
    if (done.has(n)) {
      continue;
    }
    done.add(n);
    if (n === to) {
      const path = [to];
      let at = to;
      while (at !== from) {
        at = back.get(at) as number;
        path.push(at);
      }
      return path.reverse();
    }
    for (const e of g.edges[n] as Edge[]) {
      const d = (dist.get(n) as number) + e.length;
      if (!closed.has(e.key) && d < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, d);
        back.set(e.to, n);
        open.push(e.to, d);
      }
    }
  }
  return undefined;
}

/**
 * The way from `a` to `b` along the charted lines whose every leg passes `rule` in `session`, or
 * none: no lines near both ends, no way along them, or the work spent (`exhausted`).
 */
export function fairwayRoute(
  session: Session,
  [a, b]: [LonLat, LonLat],
  c: { rule: PassRule; draft?: number; reach: number; exhausted: () => boolean }
): LonLat[] | undefined {
  const margin = Math.max(2000, haversine(a, b) / 2) / 111_320;
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const sw: LonLat = [Math.min(a[0], b[0]) - margin / k, Math.min(a[1], b[1]) - margin];
  const ne: LonLat = [Math.max(a[0], b[0]) + margin / k, Math.max(a[1], b[1]) + margin];
  const legs = legsIn(session, sw, ne, c.draft);
  if (legs.length === 0) {
    return undefined;
  }
  const g = graphOf(legs, [a, b], c.reach);
  return passingWay(
    g,
    [g.node(a), g.node(b)],
    (p, q) => strictMode(c.rule).joins(checkLeg(session, p, q)),
    c.exhausted
  );
}

/**
 * Dijkstra's way between `ends`, its legs checked (`passes`) once each; a leg that does not pass
 * is closed and the way found again, ROUNDS times at most, or until the work is spent.
 */
function passingWay(
  g: Graph,
  [from, to]: [number, number],
  passes: (p: LonLat, q: LonLat) => boolean,
  exhausted: () => boolean
): LonLat[] | undefined {
  const checked = new Map<string, boolean>();
  const closed = new Set<string>();
  for (let round = 0; round < ROUNDS && !exhausted(); round++) {
    const path = shortest(g, from, to, closed);
    if (!path) {
      return undefined;
    }
    const failed = path.slice(1).findIndex((q, i) => {
      const p = path[i] as number;
      const key = p < q ? `${p}-${q}` : `${q}-${p}`;
      let ok = checked.get(key);
      if (ok === undefined) {
        ok = passes(g.points[p] as LonLat, g.points[q] as LonLat);
        checked.set(key, ok);
      }
      if (!ok) {
        closed.add(key);
      }
      return !ok;
    });
    if (failed < 0) {
      return path.map((n) => g.points[n] as LonLat);
    }
  }
  return undefined;
}
