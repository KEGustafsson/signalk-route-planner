import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { Verdict } from "../oracle/contract";
import type { RiskCost } from "./fallback";
import { verdictWeight } from "./fallback";
import type { PassRule } from "./passes";
import { passes } from "./passes";
import type { Narrow } from "./narrow";
import { narrowShare } from "./narrow";
import type { Preferred } from "./prefer";
import { offShare } from "./prefer";
import type { PullLimits } from "./pull";
import type { QuadTree } from "./quadtree";

/**
 * Taut-string refinement (plan §4.1 step 4). String pulling keeps the search's own points,
 * square centres and edge midpoints, so a route turns near an island, not at its corner, and
 * zig-zags where samples of shortcuts failed. Here the pulled route is drawn tight: shortcuts are
 * tried outward from each point, each turn's corner is cut by the longest chord that passes, from
 * a point back along the leg into it to one as far along the leg out (binary searched), and each
 * turn is moved toward the straight line between its neighbours as far as its two legs still
 * pass, binary searched, until a round gains next to nothing. A turn so ends where the water stops
 * it, at the obstacle's corner. The cut is what draws a route off a chain of long lines (the
 * fairway stage's, `plan/fairway.ts`): a turn there joins legs kilometres long, and a shortcut to
 * either neighbour, or a turn moved toward their line, crosses what lies inside the corner.
 *
 * A change is kept only when every new leg is checked, costs less than the legs it replaces at
 * the route's own price (`TautRule.cost`, length where the route passes), and is no worse, in
 * status or risk, than the worst of them: a strict route stays strict, and a fallback route
 * never draws more failing or unverifiable water than it had. It stops cleanly when its share of
 * the work is spent, keeping the last checked route.
 */

export interface TautRule {
  /** Per-metre price of a leg with verdict `v` from a to b; Infinity where it may not go. */
  cost(v: Verdict, a: LonLat, b: LonLat): number;
  /** How bad a leg is: 0 where it passes, higher as it gets worse. */
  rank(v: Verdict): number;
  /**
   * Cut corners too (`Tightener.cut`): for a route of long legs, a chain of fairway lines or a
   * route's straightened parts. A search's route turns at its squares, close together, and is
   * drawn tight without it, at no cost in checks.
   */
  cutCorners?: boolean;
  /**
   * A leg the rule passes may replace legs of lower risk: a strict route's shortest, where any
   * passing leg is as good as another, as the search's own price has it. Without it, as for a
   * fallback's or a risk-weighted route, no new leg carries more risk than the worst it replaces.
   */
  passing?: boolean;
}

/** Bisection steps when moving a turn: its last step is 1/64 of the way to the line. */
const STEPS = 6;
/** Rounds stop when one shortens the route by less than this share of its length. */
const SETTLED = 1e-4;
/** Rounds at most. */
const ROUNDS = 8;
/** A turn closer than this to its neighbours' line, metres, is left as it is. */
const STRAIGHT_M = 1;
/** A corner whose shorter leg is under this, metres, is not cut. */
const CUT_MIN_M = 20;
/**
 * A cut is kept only when it shortens the route by at least this, metres: a cut adds a turn,
 * worth it on a corner of long legs, not to nibble metres off a short zig-zag.
 */
const CUT_GAIN_M = 20;

type Check = (a: LonLat, b: LonLat) => Verdict;

interface Leg {
  v: Verdict;
  length: number;
  cost: number;
}

/** A local plane, metres, about a point: fine for one turn's few kilometres. */
function plane(o: LonLat): { to(p: LonLat): [number, number]; from(x: number, y: number): LonLat } {
  const kx = 111_320 * Math.cos((o[1] * Math.PI) / 180);
  const ky = 110_540;
  return {
    to: (p) => [(p[0] - o[0]) * kx, (p[1] - o[1]) * ky],
    from: (x, y) => [o[0] + x / kx, o[1] + y / ky]
  };
}

/** The point of segment a–b nearest p. */
function foot(a: LonLat, b: LonLat, p: LonLat): LonLat {
  const pl = plane(p);
  const [ax, ay] = pl.to(a);
  const [bx, by] = pl.to(b);
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx - ay * dy) / l2));
  return pl.from(ax + t * dx, ay + t * dy);
}

const toward = (p: LonLat, m: LonLat, t: number): LonLat => [
  p[0] + t * (m[0] - p[0]),
  p[1] + t * (m[1] - p[1])
];

/** A corner's cut: the chord's ends, the legs replacing the corner's two, and what it saves, m. */
interface Cut {
  x: LonLat;
  y: LonLat;
  legs: Leg[];
  gain: number;
}

class Tightener {
  readonly pts: LonLat[];
  readonly legs: Leg[] = [];
  private readonly cache = new Map<string, Verdict>();

  constructor(
    points: readonly LonLat[],
    private readonly check: Check,
    private readonly rule: TautRule,
    private readonly spent: () => boolean
  ) {
    this.pts = [...points];
  }

  /** The leg a → b, checked once; undefined once the work is spent. */
  leg(a: LonLat, b: LonLat): Leg | undefined {
    const key = `${a[0]},${a[1]};${b[0]},${b[1]}`;
    let v = this.cache.get(key);
    if (!v) {
      if (this.spent()) {
        return undefined;
      }
      v = this.check(a, b);
      this.cache.set(key, v);
    }
    const length = haversine(a, b);
    return { v, length, cost: length * this.rule.cost(v, a, b) };
  }

  /** The current legs, checked; false when the work ran out first. */
  measure(): boolean {
    this.legs.length = 0;
    for (let k = 1; k < this.pts.length; k++) {
      const l = this.leg(this.pts[k - 1] as LonLat, this.pts[k] as LonLat);
      if (!l) {
        return false;
      }
      this.legs.push(l);
    }
    return true;
  }

  /**
   * Whether `fresh` legs may replace legs i..j-1: each priced, cheaper in all, at no higher
   * risk than the worst they replace, and at each rank above passing neither more legs nor more
   * length than before, so no leg is drawn into worse water and risk never compounds.
   */
  better(fresh: readonly Leg[], i: number, j: number): boolean {
    const old = this.legs.slice(i, j);
    const risk = Math.max(...old.map((l) => l.v.risk));
    const was = old.reduce((s, l) => s + l.cost, 0);
    const now = fresh.reduce((s, l) => s + l.cost, 0);
    // Under `passing`, a leg the rule passes is as good as any other that does.
    const fine = (l: Leg): boolean =>
      l.v.risk <= risk || (this.rule.passing === true && this.rule.rank(l.v) === 0);
    if (!fresh.every((l) => Number.isFinite(l.cost) && fine(l)) || now >= was - 1e-6) {
      return false;
    }
    const at = (legs: readonly Leg[], r: number): { n: number; m: number } => {
      const worse = legs.filter((l) => this.rule.rank(l.v) >= r);
      return { n: worse.length, m: worse.reduce((s, l) => s + l.length, 0) };
    };
    for (let r = 1; r <= Math.max(...fresh.map((l) => this.rule.rank(l.v))); r++) {
      const before = at(old, r);
      const after = at(fresh, r);
      if (after.n > before.n || after.m > before.m + 1e-6) {
        return false;
      }
    }
    return true;
  }

  length(): number {
    return this.pts.slice(1).reduce((s, b, k) => s + haversine(this.pts[k] as LonLat, b), 0);
  }

  /**
   * Shortcuts outward from each point: the next later points tried in turn while the leg to
   * them is better, the farthest such taken. Short legs first, so a failing long chord is never
   * paid for.
   */
  shortcuts(): boolean {
    for (let i = 0; i < this.pts.length - 2; i++) {
      let take = -1;
      let leg: Leg | undefined;
      for (let j = i + 2; j < this.pts.length; j++) {
        const l = this.leg(this.pts[i] as LonLat, this.pts[j] as LonLat);
        if (!l) {
          return false;
        }
        if (!this.better([l], i, j)) {
          break;
        }
        take = j;
        leg = l;
      }
      if (take > 0 && leg) {
        this.pts.splice(i + 1, take - i - 1);
        this.legs.splice(i, take - i, leg);
      }
    }
    return true;
  }

  /**
   * Each turn's corner cut: a point back along the leg into it and one along the leg out of it,
   * joined by a chord, the cut the longest of its shape whose chord leaves the route better,
   * binary searched, of three shapes the one saving most (`bestCut`). The legs kept on either side lie inside legs already checked, whose
   * corridors hold theirs, so they keep those verdicts; only the chord is checked.
   */
  cut(): boolean {
    for (let k = 1; k < this.pts.length - 1; k++) {
      const found = this.bestCut(k);
      if (found === false) {
        return false;
      }
      if (found) {
        this.splice(k, found);
        k++;
      }
    }
    return true;
  }

  /** Turn k's longest chord that leaves the route better; undefined: none; false: work spent. */
  private bestCut(k: number): Cut | undefined | false {
    const a = this.pts[k - 1] as LonLat;
    const p = this.pts[k] as LonLat;
    const b = this.pts[k + 1] as LonLat;
    const into = this.legs[k - 1] as Leg;
    const out = this.legs[k] as Leg;
    const reach = Math.min(into.length, out.length);
    if (reach < CUT_MIN_M || haversine(p, foot(a, b, p)) < STRAIGHT_M) {
      return undefined;
    }
    // Where the corner's chord may start and end, for t from 1 down: the same way back and on;
    // back along the leg in, then straight to the next point; or straight from the last point
    // to a point along the leg out. What lies inside a corner seldom lies square in it.
    const shapes: ((t: number) => [number, number])[] = [
      (t) => [t * reach, t * reach],
      (t) => [t * into.length, out.length],
      (t) => [into.length, t * out.length]
    ];
    let best: Cut | undefined;
    for (const shape of shapes) {
      const found = this.cutOf(k, shape);
      if (found === false) {
        return false;
      }
      if (found && (!best || found.gain > best.gain)) {
        best = found;
      }
    }
    return best;
  }

  /**
   * Turn k's longest cut of one shape (`shape(t)`: how far back along the leg in and on along
   * the leg out the chord starts and ends) that leaves the route better, t binary searched.
   */
  private cutOf(k: number, shape: (t: number) => [number, number]): Cut | undefined | false {
    const a = this.pts[k - 1] as LonLat;
    const p = this.pts[k] as LonLat;
    const b = this.pts[k + 1] as LonLat;
    const into = this.legs[k - 1] as Leg;
    const out = this.legs[k] as Leg;
    const part = (l: Leg, length: number): Leg => ({
      v: l.v,
      length,
      cost: l.cost * (length / l.length)
    });
    let lo = 0;
    let hi = 1;
    let kept: Cut | undefined;
    for (let s = 0; s < STEPS; s++) {
      const t = s === 0 ? 1 : (lo + hi) / 2;
      const [dIn, dOut] = shape(t);
      const x = toward(p, a, dIn / into.length);
      const y = toward(p, b, dOut / out.length);
      // The gain is known before the chord is checked, and shrinks with the cut: once too
      // small, so is every smaller cut of the shape, and none is checked.
      const gain = dIn + dOut - haversine(x, y);
      if (gain < CUT_GAIN_M) {
        break;
      }
      const chord = this.leg(x, y);
      if (!chord) {
        return false;
      }
      const legs = [part(into, into.length - dIn), chord, part(out, out.length - dOut)];
      if (this.better(legs, k - 1, k + 1)) {
        lo = t;
        kept = { x, y, legs, gain };
        if (t === 1) {
          break;
        }
      } else {
        hi = t;
      }
    }
    return kept;
  }

  /** Turn k replaced by the cut's two points and legs, a point dropped where it meets its neighbour. */
  private splice(k: number, c: Cut): void {
    const [l0, chord, l2] = c.legs as [Leg, Leg, Leg];
    const pts: LonLat[] = [];
    const legs: Leg[] = [];
    if (l0.length > 1e-3) {
      pts.push(c.x);
      legs.push(l0);
    }
    legs.push(chord);
    if (l2.length > 1e-3) {
      pts.push(c.y);
      legs.push(l2);
    }
    this.pts.splice(k, 1, ...pts);
    this.legs.splice(k - 1, 2, ...legs);
  }

  /** Each turn moved toward its neighbours' line as far as its legs stay better. */
  relax(): boolean {
    for (let k = 1; k < this.pts.length - 1; k++) {
      const a = this.pts[k - 1] as LonLat;
      const p = this.pts[k] as LonLat;
      const b = this.pts[k + 1] as LonLat;
      const m = foot(a, b, p);
      if (haversine(p, m) < STRAIGHT_M) {
        continue;
      }
      let lo = 0;
      let hi = 1;
      let kept: { q: LonLat; legs: [Leg, Leg] } | undefined;
      for (let s = 0; s < STEPS; s++) {
        const t = s === 0 ? 1 : (lo + hi) / 2;
        const q = toward(p, m, t);
        const l1 = this.leg(a, q);
        const l2 = l1 && this.leg(q, b);
        if (!l1 || !l2) {
          return false;
        }
        if (this.better([l1, l2], k - 1, k + 1)) {
          lo = t;
          kept = { q, legs: [l1, l2] };
          if (t === 1) {
            break;
          }
        } else {
          hi = t;
        }
      }
      if (kept) {
        this.pts[k] = kept.q;
        this.legs.splice(k - 1, 2, ...kept.legs);
      }
    }
    return true;
  }
}

/**
 * The route `points`, drawn tight under `rule`. Always a route of checked legs, each no worse
 * than the one it replaced: with the work spent part way, the last such route.
 */
export async function taut(
  points: readonly LonLat[],
  check: Check,
  limits: PullLimits,
  rule: TautRule
): Promise<LonLat[]> {
  if (points.length <= 2) {
    return [...points];
  }
  const t = new Tightener(points, check, rule, () => limits.exhausted());
  if (!t.measure()) {
    return [...points];
  }
  for (let round = 0; round < ROUNDS; round++) {
    const before = t.length();
    const done = t.shortcuts() && (rule.cutCorners !== true || t.cut()) && t.relax();
    await limits.pause();
    if (!done || before - t.length() < SETTLED * before) {
      break;
    }
  }
  return distinct(t.pts);
}

/**
 * `points` with each point that repeats the one before it left out; the ends stay. A turn moved
 * all the way to its neighbours' line can land on a neighbour, and the two are then one point:
 * left in, a route would carry a leg of no length.
 */
function distinct(points: readonly LonLat[]): LonLat[] {
  const out: LonLat[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || haversine(last, p) > SAME_M) {
      out.push(p);
    }
  }
  // The route's own last point, not one a hair from it.
  const end = points[points.length - 1];
  if (end && out.length > 1) {
    out[out.length - 1] = end;
  }
  return out;
}

/** Points closer than this, metres, are one point. */
const SAME_M = 1e-3;

const STATUS_RANK: Record<string, number> = { ok: 0, marginal: 1, unverified: 2, fail: 3 };

/**
 * A strict route's price: its length where `rule` passes a leg, nowhere else, corners cut. Every
 * passing leg is as good as another, as the shortest search prices them.
 */
export const strictRule = (rule: PassRule): TautRule => ({
  cost: (v) => (passes(v, rule) ? 1 : Infinity),
  rank: (v) => (passes(v, rule) ? 0 : 3),
  // A chain of lines and a route's straightened parts turn between long legs.
  cutCorners: true,
  passing: true
});

/**
 * A fallback route's price, as its search weighs water it may cross (`verdictWeight`), corners
 * cut: no new leg carries more risk than the worst it replaces, nor worse water.
 */
export const crossingRule = (rule: PassRule): TautRule => ({
  cost: (v) => verdictWeight(v, rule, { fallback: true }),
  rank: (v) => (passes(v, rule) ? 0 : (STATUS_RANK[v.status] ?? 3)),
  cutCorners: true
});

/**
 * The search's own price of a leg, as pulling prices it (`verdictWeight`, the lines' cost
 * off them), and its rank: 0 where `rule` passes it, else by status.
 */
export function tautRule(
  tree: QuadTree,
  rule: PassRule,
  how: {
    fallback: boolean;
    cost: RiskCost | undefined;
    pref: Preferred | undefined;
    narrow?: Narrow | undefined;
  }
): TautRule {
  const { pref, narrow } = how;
  return {
    cost: (v, a, b) =>
      verdictWeight(v, rule, { fallback: how.fallback, ...(how.cost && { cost: how.cost }) }) +
      (pref ? pref.weight * offShare(pref, tree.units(a), tree.units(b), tree) : 0) +
      (narrow ? narrow.weight * narrowShare(narrow, tree, a, b) : 0),
    rank: (v) => (passes(v, rule) ? 0 : (STATUS_RANK[v.status] ?? 3)),
    // A strict route without a risk cost prices every passing leg alike, as A* did.
    passing: !how.fallback && how.cost === undefined
  };
}

/**
 * `taut` on half the work `session` has left of `maxWork`, so the stages after it keep the rest.
 */
export function tautWithin(
  points: readonly LonLat[],
  check: Check,
  budget: { session: { work(): number; pause(): Promise<void> }; maxWork: number },
  rule: TautRule
): Promise<LonLat[]> {
  const { session } = budget;
  const stop = session.work() + (budget.maxWork - session.work()) / 2;
  return taut(
    points,
    check,
    { exhausted: () => session.work() >= stop, pause: () => session.pause() },
    rule
  );
}
