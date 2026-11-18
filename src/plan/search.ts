import type { LonLat } from "../foundation/geo";
import { frameAt, haversine, midpoint } from "../foundation/geo";
import type { Session, Verdict } from "../oracle/contract";
import { aStar } from "../search/astar";
import type { PassRule } from "../search/passes";
import { OK_ONLY, passes } from "../search/passes";
import { crossable, fallbackShortcut, fallbackWeight } from "../search/fallback";
import type { Shortcut } from "../search/pull";
import { pull } from "../search/pull";
import type { QuadNode, TreeShape } from "../search/quadtree";
import { centre, MAX_BOX_KM2, QuadTree } from "../search/quadtree";
import { stuckEnds } from "./handover";
import type { PlanOptions } from "./options";

/**
 * The static search (plan §4.1): the direct line first, then a quadtree over the
 * region, A* through its free squares and string pulling. Every point it
 * returns is a suggestion for the proof step; the route check decides.
 */

export type SearchOutcome =
  | {
      ok: true;
      coordinates: LonLat[];
      direct: Verdict;
      squares: number;
      work: number;
      /** Set when no route passed and this is the least risky one: why none passed. */
      fallback?: string;
      /** Where a berth leg (`berthMetres`) leaves the start or reaches the destination. */
      berths?: Berths;
    }
  | {
      ok: false;
      reason: string;
      direct: Verdict;
      squares: number;
      /** One-unit squares the check could not verify that the search met. */
      unverified: number;
      work: number;
      /**
       * Set when the start or destination could not be joined: free water near each such
       * end, nearest first, where a harbour stage may hand over (plan §4.1, harbour stage).
       */
      stuck?: Stuck;
    };

/** The berth leg's inner point at the start or the destination. */
export interface Berths {
  start?: LonLat;
  end?: LonLat;
}

/** Handover candidates for each end that could not be joined. */
export interface Stuck {
  start?: LonLat[];
  end?: LonLat[];
}

/** A box with its corridor buffer at the frame's origin stays under MAX_BOX_KM2. */
const MAX_BOX_SIDE = Math.sqrt(MAX_BOX_KM2 * 1e6);

/** Legs whose corridor is over this, km², are never checked as one leg (the API refuses 25). */
const MAX_LEG_KM2 = 24;

const NOT_CHECKED: Verdict = { status: "unverified", risk: 0, flags: ["TOO_LONG_FOR_ONE_LEG"] };

/**
 * The leg a → b checked through the session, or NOT_CHECKED when its corridor (length plus
 * both ends, times twice the half-width) is over MAX_LEG_KM2: the planning API throws on those.
 */
export function checkLeg(session: Session, a: LonLat, b: LonLat): Verdict {
  const r = session.halfWidth;
  return ((haversine(a, b) + 2 * r) * 2 * r) / 1e6 > MAX_LEG_KM2
    ? NOT_CHECKED
    : session.segment(a, b);
}

const pow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/** The quadtree's shape around start and goal, or why there is none. */
export function shapeFor(
  from: LonLat,
  to: LonLat,
  halfWidth: number,
  opts: PlanOptions
): TreeShape | string {
  const d = haversine(from, to);
  const half = d / 2 + Math.max(d / 2, opts.minMargin);
  let unit = Math.max(opts.minCell, halfWidth / 2);
  while (pow2((2 * half) / unit) > opts.maxSideUnits) {
    unit *= 2;
  }
  const side = pow2((2 * half) / unit);
  const leafMetres = Math.min(opts.maxLeafMetres, MAX_BOX_SIDE - 2 * halfWidth);
  if (leafMetres < unit) {
    return `the corridor half-width ${Math.round(halfWidth)} m is too wide to plan in`;
  }
  const maxLeaf = 2 ** Math.floor(Math.log2(leafMetres / unit));
  const extent = (side * unit) / 2;
  const frame = frameAt(midpoint(from, to));
  // Planning API v1 boxes are west–east corner pairs: none may cross the 180° meridian.
  if (frame.toLonLat(-extent, 0)[0] > frame.toLonLat(extent, 0)[0]) {
    return "the planning region crosses the 180° meridian, which the planning API does not take";
  }
  if (
    Math.abs(frame.toLonLat(0, extent)[1]) >= 90 ||
    Math.abs(frame.toLonLat(0, -extent)[1]) >= 90
  ) {
    return "the planning region reaches a pole";
  }
  return { frame, x0: -extent, y0: -extent, unit, side, maxLeaf };
}

interface Access {
  leaf: QuadNode;
  /** Where the search starts or ends in the leaf, unit coordinates. */
  at: [number, number];
  /** The start or goal point itself, when it joins the leaf by a checked leg. */
  joined?: LonLat;
  /** Where the berth leg from `joined` ends, when only a berth leg reaches it. */
  berth?: LonLat;
}

/** What a search may cross: strictly passing water, or for the fallback, charted water at a cost. */
export interface Mode {
  enter(n: QuadNode): boolean;
  /** True when a checked leg may join the start or goal to a square. */
  joins(v: Verdict): boolean;
  weight?(n: QuadNode): number;
}

const strictMode = (rule: PassRule): Mode => ({
  enter: (n) => n.state === "free",
  joins: (v) => passes(v, rule)
});

const FALLBACK: Mode = {
  enter: (n) => Number.isFinite(fallbackWeight(n)),
  joins: (v) => crossable(v),
  weight: fallbackWeight
};

const WORK_LIMIT =
  "the search reached its work limit; plan a shorter passage or add a waypoint between";

/**
 * The square the search leaves from or arrives at for point `p`: the one holding
 * it, or the nearest within `accessMetres` whose centre a checked leg from `p` (to
 * `p`, for the goal) joins.
 */
function access(
  tree: QuadTree,
  session: Session,
  p: LonLat,
  goal: boolean,
  opts: PlanOptions,
  mode: Mode,
  exhausted: () => boolean,
  berth = 0
): Access | string {
  const [ux, uy] = tree.units(p);
  const own = tree.leafAt(ux, uy);
  if (own && mode.enter(own)) {
    return { leaf: own, at: [ux, uy] };
  }
  const r = opts.accessMetres / tree.shape.unit;
  const near = tree
    .leaves(
      (n) => n.x < ux + r && ux - r < n.x + n.size && n.y < uy + r && uy - r < n.y + n.size,
      exhausted
    )
    .filter((n) => mode.enter(n))
    .map((n) => ({ n, d: Math.hypot(centre(n)[0] - ux, centre(n)[1] - uy) }))
    .filter(({ n }) => {
      const c = centre(n);
      return haversine(p, tree.lonLat(c[0], c[1])) <= opts.accessMetres;
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);
  for (const { n } of near) {
    if (exhausted()) {
      return WORK_LIMIT;
    }
    const c = centre(n);
    const cl = tree.lonLat(c[0], c[1]);
    if (mode.joins(goal ? checkLeg(session, cl, p) : checkLeg(session, p, cl))) {
      return { leaf: n, at: c, joined: p };
    }
  }
  const stub =
    berth > 0
      ? berthJoin(
          tree,
          session,
          { p, goal, berth, mode },
          near.map((x) => x.n)
        )
      : undefined;
  if (stub) {
    return stub;
  }
  if (exhausted()) {
    return WORK_LIMIT;
  }
  const what = goal ? "destination" : "start";
  const flags = own?.verdict?.flags.length ? ` (${own.verdict.flags.join(", ")})` : "";
  return `no water the route check passes within ${opts.accessMetres} m of the ${what}${flags}`;
}

/** The point `d` metres from `p` toward `q`; short distances, so linear in degrees. */
function toward(p: LonLat, q: LonLat, d: number): LonLat {
  const t = Math.min(1, d / Math.max(haversine(p, q), 1e-9));
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/**
 * A berth leg (plan §4.1): when no checked leg joins `p` because the quay or pier it lies
 * at is inside the corridor, the shortest stub from `p` toward a square's centre, at most
 * `berth` metres, beyond which a checked leg joins. The stub itself is not checked by the
 * search; the route check marks it.
 */
function berthJoin(
  tree: QuadTree,
  session: Session,
  end: { p: LonLat; goal: boolean; berth: number; mode: Mode },
  near: QuadNode[]
): Access | undefined {
  const { p, goal, berth, mode } = end;
  for (const n of near) {
    const c = centre(n);
    const cl = tree.lonLat(c[0], c[1]);
    const joinsAt = (d: number): boolean => {
      const q = toward(p, cl, d);
      return mode.joins(goal ? checkLeg(session, cl, q) : checkLeg(session, q, cl));
    };
    let hi = Math.min(berth, 0.9 * haversine(p, cl));
    if (hi <= 0 || !joinsAt(hi)) {
      continue;
    }
    let lo = 0;
    for (let k = 0; k < 5; k++) {
      const mid = (lo + hi) / 2;
      if (joinsAt(mid)) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return { leaf: n, at: c, joined: p, berth: toward(p, cl, hi) };
  }
  return undefined;
}

/**
 * The search's points with its first and last replaced by the given ends, when the search
 * starts or ends at them: the frame's round trip moves them in the last bits, and a part that
 * hands over must meet the next at the very same coordinate.
 */
function exactEnds(points: LonLat[], first?: LonLat, last?: LonLat): LonLat[] {
  const out = [...points];
  if (first && out.length > 0) {
    out[0] = first;
  }
  if (last && out.length > 0) {
    out[out.length - 1] = last;
  }
  return out;
}

type Attempt =
  { path: LonLat[]; berths: Berths } | { reason: string; stuck?: { start: boolean; end: boolean } };

/** The path through the search's points, with the joined ends and their berth legs. */
function pathOf(
  tree: QuadTree,
  [start, goal]: [Access, Access],
  ends: [LonLat, LonLat],
  points: [number, number][]
): { path: LonLat[]; berths: Berths } {
  return {
    path: [
      ...(start.joined ? [start.joined] : []),
      ...(start.berth ? [start.berth] : []),
      ...exactEnds(
        points.map(([x, y]) => tree.lonLat(x, y)),
        start.joined ? undefined : ends[0],
        goal.joined ? undefined : ends[1]
      ),
      ...(goal.berth ? [goal.berth] : []),
      ...(goal.joined ? [goal.joined] : [])
    ],
    berths: {
      ...(start.berth && { start: start.berth }),
      ...(goal.berth && { end: goal.berth })
    }
  };
}

/** One search from `from` to `to` in `mode`: the raw path, or why there is none. */
async function attempt(
  tree: QuadTree,
  session: Session,
  ends: [LonLat, LonLat],
  opts: PlanOptions,
  mode: Mode,
  berth = 0
): Promise<Attempt> {
  const searchWork = opts.maxWork * opts.searchShare;
  const exhausted = (): boolean => session.work() >= searchWork;
  const start = access(tree, session, ends[0], false, opts, mode, exhausted, berth);
  const goal =
    start === WORK_LIMIT
      ? start
      : access(tree, session, ends[1], true, opts, mode, exhausted, berth);
  if (start === WORK_LIMIT || goal === WORK_LIMIT) {
    return { reason: WORK_LIMIT };
  }
  if (typeof start === "string" || typeof goal === "string") {
    return {
      reason: typeof start === "string" ? start : (goal as string),
      stuck: { start: typeof start === "string", end: typeof goal === "string" }
    };
  }
  const found =
    start.leaf === goal.leaf
      ? { found: true as const, points: [start.at, goal.at] }
      : await aStar(tree, start.leaf, start.at, goal.leaf, goal.at, {
          exhausted,
          pause: () => session.pause(),
          every: 64,
          weight: mode.weight
        });
  if (!found.found) {
    return {
      reason:
        found.reason === "work"
          ? WORK_LIMIT
          : tree.unverified > 0
            ? "no route the check passes connects the points; the search met water the check cannot verify (no chart coverage or unassessed survey), which a route may need"
            : "no route the check passes connects the points: land, shoals or obstacles close every way"
    };
  }
  return pathOf(tree, [start, goal], ends, found.points);
}

type Searched =
  | { path: LonLat[]; berths: Berths; shortcut?: Shortcut; fallback?: string }
  | { reason: string; stuck?: Stuck };

/**
 * The strict attempt, then with `fallback` the fallback over the same squares. A refusal at an
 * end names the free water near it: strictly passing, else what the fallback may cross.
 */
async function searchTree(
  tree: QuadTree,
  session: Session,
  ends: [LonLat, LonLat],
  opts: PlanOptions,
  how: { rule: PassRule; fallback: boolean; berth: number }
): Promise<Searched> {
  const strict = await attempt(tree, session, ends, opts, strictMode(how.rule), how.berth);
  if ("path" in strict) {
    return strict;
  }
  const again =
    how.fallback && strict.reason !== WORK_LIMIT
      ? await attempt(tree, session, ends, opts, FALLBACK, how.berth)
      : undefined;
  if (again && "path" in again) {
    return { ...again, shortcut: fallbackShortcut(tree, again.path), fallback: strict.reason };
  }
  // The fallback stopped at the work limit: say so, not why the strict search found no way.
  if (again?.reason === WORK_LIMIT) {
    return { reason: WORK_LIMIT };
  }
  const exhausted = () => session.work() >= opts.maxWork * opts.searchShare;
  const near =
    stuckEnds(tree, ends, strict.stuck, opts, { ...strictMode(how.rule), exhausted }) ??
    (again ? stuckEnds(tree, ends, again.stuck, opts, { ...FALLBACK, exhausted }) : undefined);
  if (near === "work") {
    return { reason: WORK_LIMIT };
  }
  return { reason: strict.reason, ...(near && { stuck: near }) };
}

/**
 * The search between `from` and `to`. `berth` > 0 lets each end join by a berth leg of at
 * most that many metres (the harbour stage); `opts.harbourMetres` > 0 makes a refusal at an
 * end name the free water near it (`stuck`).
 */
export async function searchRoute(
  session: Session,
  from: LonLat,
  to: LonLat,
  opts: PlanOptions,
  rule: PassRule = OK_ONLY,
  fallback = false,
  berth = 0
): Promise<SearchOutcome> {
  const direct = checkLeg(session, from, to);
  if (passes(direct, rule)) {
    return { ok: true, coordinates: [from, to], direct, squares: 0, work: session.work() };
  }
  const shape = shapeFor(from, to, session.halfWidth, opts);
  const tree = typeof shape === "string" ? undefined : new QuadTree(shape, session, rule);
  const refuse = (reason: string, stuck?: Stuck): SearchOutcome => ({
    ok: false,
    reason,
    direct,
    squares: tree?.classified ?? 0,
    unverified: tree?.unverified ?? 0,
    work: session.work(),
    ...(stuck && { stuck })
  });
  if (!tree) {
    return refuse(shape as string);
  }
  const found = await searchTree(tree, session, [from, to], opts, { rule, fallback, berth });
  if ("reason" in found) {
    return refuse(found.reason, found.stuck);
  }
  const coordinates = await pull(
    found.path,
    (a, b) => checkLeg(session, a, b),
    { exhausted: () => session.work() >= opts.maxWork, pause: () => session.pause() },
    rule,
    found.shortcut
  );
  // The last shortcut checked may have taken the work past the limit.
  if (coordinates === "work" || session.work() >= opts.maxWork) {
    return refuse(WORK_LIMIT);
  }
  return {
    ok: true,
    coordinates,
    direct,
    squares: tree.classified,
    work: session.work(),
    ...(found.fallback !== undefined && { fallback: found.fallback }),
    ...((found.berths.start || found.berths.end) && { berths: found.berths })
  };
}
