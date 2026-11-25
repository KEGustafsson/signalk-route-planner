import type { LonLat } from "../foundation/geo";
import type { Session, Verdict } from "../oracle/contract";
import type { RiskCost } from "../search/fallback";
import { crossable, fallbackWeight, strictWeight } from "../search/fallback";
import type { PassRule } from "../search/passes";
import { passes } from "../search/passes";
import type { Narrow } from "../search/narrow";
import { narrowCost } from "../search/narrow";
import type { Preferred, PreferredLine } from "../search/prefer";
import { offLine, preferredIn } from "../search/prefer";
import { IdMap } from "../search/id-map";
import type { QuadNode, QuadTree } from "../search/quadtree";
import type { PlanOptions } from "./options";

/**
 * What a search may cross and what each square costs it (plan §4.1, §4.4): strictly passing
 * water, or for the fallback charted water at a cost, each with the request's risk cost and
 * the preference lines a session lists.
 */

/** What a search may cross: strictly passing water, or for the fallback, charted water at a cost. */
export interface Mode {
  enter(n: QuadNode): boolean;
  /** True when a checked leg may join the start or goal to a square. */
  joins(v: Verdict): boolean;
  weight?(n: QuadNode): number;
  /**
   * True when the weight carries a preference smaller than weighted A*'s slack: a risk cost or
   * preference lines.
   */
  fine?: boolean;
}

export const strictMode = (rule: PassRule, cost?: RiskCost): Mode => ({
  enter: (n) => Number.isFinite(strictWeight(n)),
  joins: (v) => passes(v, rule) || (v.status === "marginal" && crossable(v)),
  weight: (n) => strictWeight(n, cost),
  fine: cost !== undefined
});

export const fallbackMode = (cost?: RiskCost): Mode => ({
  enter: (n) => Number.isFinite(fallbackWeight(n)),
  joins: (v) => crossable(v),
  weight: (n) => fallbackWeight(n, cost),
  fine: cost !== undefined
});

/** `mode` with the lines' preference added to every square it may cross. */
export function preferring(mode: Mode, pref: Preferred | undefined): Mode {
  const base = mode.weight;
  if (!pref || !base) {
    return mode;
  }
  const off = new IdMap<number>();
  return {
    ...mode,
    fine: true,
    weight: (n) => {
      const w = base(n);
      if (!Number.isFinite(w)) {
        return w;
      }
      let o = off.get(n.id);
      if (o === undefined) {
        o = offLine(pref, n);
        off.set(n.id, o);
      }
      return w + o;
    }
  };
}

/** `mode` with narrow water's added cost on every square it may cross (`search/narrow.ts`). */
export function narrowing(mode: Mode, narrow: Narrow | undefined): Mode {
  const base = mode.weight;
  if (!narrow || !base) {
    return mode;
  }
  // The way through a sound and the way round it may differ by less than weighted A*'s slack:
  // a fine search, as for a risk cost or lines, so the cheaper is found.
  return {
    ...mode,
    fine: true,
    weight: (n) => {
      const w = base(n);
      return Number.isFinite(w) ? w + narrowCost(narrow, n) : w;
    }
  };
}

/** The classes of chart objects whose lines a route keeps to. */
const PREFERRED = new Set(["NAVLNE", "RECTRC", "NAVLINE", "TRACK"]);

/** The preference lines a session lists in the tree's region, in its units. */
export function linesIn(
  tree: QuadTree,
  session: Session,
  ends: [LonLat, LonLat],
  opts: PlanOptions
): Preferred | undefined {
  if (!opts.preferLines || !session.objects || opts.preferWeight <= 0) {
    return undefined;
  }
  const side = tree.shape.side;
  const [a, b] = [tree.lonLat(0, 0), tree.lonLat(side, side)];
  const sw: LonLat = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
  const ne: LonLat = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  let objects;
  try {
    objects = session.objects(sw, ne);
  } catch (err) {
    // A region too large to list is planned without lines: they only ever add a preference.
    if (err instanceof RangeError) {
      return undefined;
    }
    throw err;
  }
  const lines: PreferredLine[] = objects
    .filter((o) => PREFERRED.has(o.class) && o.geometry.type === "LineString")
    .filter((o) => !(o.designDraft !== undefined && (opts.preferDraft ?? 0) > o.designDraft))
    .map((o) => ({
      coordinates: o.geometry.coordinates as LonLat[],
      ...(o.twoWay === true && { twoWay: true })
    }));
  return preferredIn(tree, lines, ends, {
    reachMetres: opts.preferReach,
    weight: opts.preferWeight,
    starboardMetres: opts.starboardOffset,
    // Squares split along a line down to the risk cost's resolution, about the reach: a square
    // whose centre is near the line is on it, and a finer band would ask the chart about many
    // more squares along every line in the region.
    cellMetres: opts.riskCell
  });
}

/** The request's risk cost: none at weight 0, the shortest route. */
export function riskCostOf(opts: PlanOptions, rule: PassRule): RiskCost | undefined {
  return opts.riskWeight > 0 && rule.probability > 0
    ? { weight: opts.riskWeight, threshold: rule.probability }
    : undefined;
}

/** True when water at P(UKC < 0) `risk` adds more than `riskSplit` to the cost per metre. */
export const weighs = (opts: PlanOptions, cost: RiskCost | undefined, risk: number): boolean =>
  cost !== undefined && (cost.weight * risk) / cost.threshold > opts.riskSplit;
