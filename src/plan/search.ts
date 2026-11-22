import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { Session, Verdict } from "../oracle/contract";
import { aStar } from "../search/astar";
import type { PassRule } from "../search/passes";
import { OK_ONLY, passes } from "../search/passes";
import type { RiskCost } from "../search/fallback";
import {
  berthable,
  crossable,
  fallbackWeight,
  costShortcut,
  riskyShortcut,
  strictWeight,
  verdictWeight
} from "../search/fallback";
import type { Preferred, PreferredLine } from "../search/prefer";
import { offLine, offShare, preferredIn, splitsForLines } from "../search/prefer";
import type { Priced, Shortcut } from "../search/pull";
import { pull } from "../search/pull";
import { tautRule, tautWithin } from "../search/taut";
import type { QuadNode } from "../search/quadtree";
import { centre, QuadTree } from "../search/quadtree";
import type { Guide } from "../search/guide";
import { memoBoxes } from "../search/guide";
import { between } from "./between";
import { stuckEnds } from "./handover";
import type { Mode } from "./modes";
import { fallbackMode, preferring, riskCostOf, strictMode } from "./modes";
import { keepsDirect, treeFor } from "./region";
import { guides } from "./steer";

export type { Mode } from "./modes";
import type { PlanOptions } from "./options";
import { shapeFor } from "./region";

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
      /** Set when no route passed and this is the lowest risk-weighted route: why none passed. */
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

interface Access {
  leaf: QuadNode;
  /** Where the search starts or ends in the leaf, unit coordinates. */
  at: [number, number];
  /** The start or goal point itself, when it joins the leaf by a checked leg. */
  joined?: LonLat;
  /** Where the berth leg from `joined` ends, when only a berth leg reaches it. */
  berth?: LonLat;
}

export const WORK_LIMIT =
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
  const within = (n: QuadNode): boolean => {
    const c = centre(n);
    return haversine(p, tree.lonLat(c[0], c[1])) <= opts.accessMetres;
  };
  // Best first: only squares nearer than the eighth candidate are classified, and the
  // query stops at the search's share of the work.
  const near = tree
    .nearest(ux, uy, r, (n) => mode.enter(n) && within(n), 8, exhausted)
    .map((n) => ({ n, d: Math.hypot(centre(n)[0] - ux, centre(n)[1] - uy) }))
    .sort((a, b) => a.d - b.d);
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
          { p, goal, berth, mode, exhausted },
          near.map((x) => x.n)
        )
      : undefined;
  // A stub found past the work limit is not offered: the search answers with the limit.
  if (exhausted()) {
    return WORK_LIMIT;
  }
  if (stub) {
    return stub;
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
 * `berth` metres, beyond which a checked leg joins. The stub may touch its quay (`LAND`), but
 * one a hard rule or no chart closes is not taken (`berthable`); the route check marks it.
 * Each check stops at the work limit.
 */
function berthJoin(
  tree: QuadTree,
  session: Session,
  end: { p: LonLat; goal: boolean; berth: number; mode: Mode; exhausted: () => boolean },
  near: QuadNode[]
): Access | undefined {
  const { p, goal, berth, mode, exhausted } = end;
  for (const n of near) {
    const c = centre(n);
    const cl = tree.lonLat(c[0], c[1]);
    const joinsAt = (d: number): boolean => {
      if (exhausted()) {
        return false;
      }
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
    // The stub lies alongside the quay, but never in water a hard rule or no chart closes.
    const q = toward(p, cl, hi);
    if (!berthable(goal ? checkLeg(session, q, p) : checkLeg(session, p, q))) {
      continue;
    }
    return { leaf: n, at: c, joined: p, berth: q };
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

/**
 * One search from `from` to `to` in `mode`: the raw path, or why there is none. With a `guide`,
 * made once both ends are joined, the search goes along its coarse path first.
 */
async function attempt(
  tree: QuadTree,
  session: Session,
  ends: [LonLat, LonLat],
  opts: PlanOptions,
  mode: Mode,
  berth = 0,
  guide?: () => Promise<Guide | undefined>
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
  const found = await between(tree, session, [start, goal], opts, { mode, exhausted, guide });
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
  | { path: LonLat[]; berths: Berths; shortcut?: Shortcut; priced?: Priced; fallback?: string }
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
  how: { rule: PassRule; fallback: boolean; berth: number; pref?: Preferred }
): Promise<Searched> {
  const cost = riskCostOf(opts, how.rule);
  const { pref } = how;
  const strictWith = preferring(strictMode(how.rule, cost), pref);
  const fallbackWith = preferring(fallbackMode(cost), pref);
  const guide = guides(tree, session, how.rule, ends, opts);
  const strict = await attempt(tree, session, ends, opts, strictWith, how.berth, guide(1));
  // With a risk cost or lines, pulling keeps to what the search paid for, by one price for all.
  const pulling = (path: LonLat[], mode: Mode, fallback: boolean) => {
    // A fallback route is straightened by its own rule (`riskyShortcut`) unless it carries a
    // risk cost: priced at a whole leg's verdict, its shortcuts through risky water never pass.
    if (!cost && (!pref || fallback)) {
      return {};
    }
    const priced = costShortcut(
      tree,
      path,
      (n) => mode.weight?.(n) ?? 1,
      (v, a, b) =>
        verdictWeight(v, how.rule, { fallback, cost }) +
        (pref ? pref.weight * offShare(pref, tree.units(a), tree.units(b), tree) : 0),
      cost
    );
    return { priced };
  };
  if ("path" in strict) {
    return {
      ...strict,
      shortcut: riskyShortcut(tree, strict.path, (v) => v.status === "marginal"),
      ...pulling(strict.path, strictWith, false)
    };
  }
  // Refused only at an end: the harbour stage plans that end in its own small region, so
  // the route stays strict and no fallback floods the whole region (plan §4.1).
  const exhausted = () => session.work() >= opts.maxWork * opts.searchShare;
  const handover = stuckEnds(tree, ends, strict.stuck, opts, {
    ...strictMode(how.rule),
    exhausted
  });
  if (handover === "work") {
    return { reason: WORK_LIMIT };
  }
  if (handover) {
    return { reason: strict.reason, stuck: handover };
  }
  const again =
    how.fallback && strict.reason !== WORK_LIMIT
      ? await attempt(tree, session, ends, opts, fallbackWith, how.berth, guide(opts.steerRisk))
      : undefined;
  if (again && "path" in again) {
    return {
      ...again,
      shortcut: riskyShortcut(tree, again.path, crossable),
      ...pulling(again.path, fallbackWith, true),
      fallback: strict.reason
    };
  }
  // The fallback stopped at the work limit: say so, not why the strict search found no way.
  if (again?.reason === WORK_LIMIT) {
    return { reason: WORK_LIMIT };
  }
  const near = again
    ? stuckEnds(tree, ends, again.stuck, opts, { ...fallbackMode(), exhausted })
    : undefined;
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
  chart: Session,
  from: LonLat,
  to: LonLat,
  opts: PlanOptions,
  rule: PassRule = OK_ONLY,
  fallback = false,
  berth = 0
): Promise<SearchOutcome> {
  const session = memoBoxes(chart);
  const direct = checkLeg(session, from, to);
  const cost = riskCostOf(opts, rule);
  const { tree, pref, shapeError } = treeFor(session, [from, to], opts, rule, cost);
  if (keepsDirect(direct, { rule, opts, cost, tree, pref }, [from, to])) {
    return { ok: true, coordinates: [from, to], direct, squares: 0, work: session.work() };
  }
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
    return refuse(shapeError as string);
  }
  const found = await searchTree(tree, session, [from, to], opts, {
    rule,
    fallback,
    berth,
    ...(pref && { pref })
  });
  if ("reason" in found) {
    return refuse(found.reason, found.stuck);
  }
  const coordinates = await pull(
    found.path,
    (a, b) => checkLeg(session, a, b),
    { exhausted: () => session.work() >= opts.maxWork, pause: () => session.pause() },
    rule,
    found.shortcut,
    found.priced
  );
  // The last shortcut checked may have taken the work past the limit.
  if (coordinates === "work" || session.work() >= opts.maxWork) {
    return refuse(WORK_LIMIT);
  }
  const tight = await tautWithin(
    coordinates,
    (a, b) => checkLeg(session, a, b),
    { session, maxWork: opts.maxWork },
    tautRule(tree, rule, { fallback: found.fallback !== undefined, cost, pref })
  );
  // Refinement's last checked leg may have taken the work past the limit.
  if (session.work() >= opts.maxWork) {
    return refuse(WORK_LIMIT);
  }
  return {
    ok: true,
    coordinates: tight,
    direct,
    squares: tree.classified,
    work: session.work(),
    ...(found.fallback !== undefined && { fallback: found.fallback }),
    ...((found.berths.start || found.berths.end) && { berths: found.berths })
  };
}
