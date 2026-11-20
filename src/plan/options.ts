/** Limits of one plan (plan §6). Work is counted in signalk-underkeel's work units, never timed. */
export interface PlanOptions {
  /** Work one plan may do, search and pulling together; sized for about 3 s on a Raspberry Pi 4. */
  maxWork: number;
  /** The share of `maxWork` after which the search stops and the plan is refused. */
  searchShare: number;
  /**
   * A*'s heuristic weight (weighted A*): the search's path costs at most this many times
   * the cheapest before string pulling, for far fewer squares classified. 1 is plain A*.
   */
  greed: number;
  /** The region's side may be at most this many smallest squares (a power of two). */
  maxSideUnits: number;
  /** Smallest square, metres, at least; also at least half the corridor half-width. */
  minCell: number;
  /**
   * Smallest square of a corridor's region, metres, at least: a long trip's shores are long,
   * and each halving of the square doubles the boxes asked along them.
   */
  corridorCell: number;
  /** Largest square the chart is asked about, metres, before its corridor buffer. */
  maxLeafMetres: number;
  /** The region reaches past start and goal by half their distance, and at least this, metres. */
  minMargin: number;
  /** Start and goal points are joined to free water this far away at most, metres. */
  accessMetres: number;
  /** Start and goal at most this far apart, metres. */
  maxDistance: number;
  /** A trip planned in a corridor (plan §4.2) may be this long, metres. */
  corridorDistance: number;
  /**
   * ...and its search may do this much work per km of its straight distance, and at least
   * `maxWork`: a long trip's shores are long, and its index took minutes to build.
   */
  corridorWorkPerKm: number;
  /** The verdict window: the trip at the request speed over this many times the straight distance. */
  windowFactor: number;
  /** ...and at least this long, ms. */
  minWindow: number;
  /**
   * An end the corridor cannot reach is planned out to open water in a harbour stage, at
   * this cross-track limit (the planning API's buffer alone at 0), metres.
   */
  harbourXte: number;
  /** The harbour stage reaches at most this far from its end, metres. */
  harbourMetres: number;
  /** The harbour stage's region reaches past its end and its handover by this, metres. */
  harbourMargin: number;
  /**
   * A berth leg: the last stretch alongside a quay or pier, inside even the harbour corridor,
   * at most this long, metres. 0 turns berth legs off.
   */
  berthMetres: number;
  /**
   * Waiting en route (`waits.ts`): a place the boat waits at passes a box this many metres
   * about it at the lowest water of the trip, room to swing at anchor.
   */
  waitSwing: number;
  /** ...and places are tried along each leg this far apart, and at the route's turns, metres. */
  waitSpacing: number;
  /**
   * The risk cost's weight α (plan §4.4): the cost per metre is 1 + α · P / threshold, P the
   * water's P(UKC < 0) and threshold the accepted probability. 0 plans the shortest route.
   */
  riskWeight: number;
  /**
   * A free square whose risk adds more than this to the cost per metre is split to find the
   * clearer water in it, and a direct line's is searched around.
   */
  riskSplit: number;
  /** ...down to squares this size, metres: the risk cost's resolution. */
  riskCell: number;
  /**
   * Preference lines (`search/prefer.ts`): water this far from a line counts as on it, metres,
   * water off every line costs `preferWeight` more per metre, and a two-way line is kept to
   * `starboardOffset` metres to starboard. A weight of 0 turns the preference off.
   */
  preferReach: number;
  preferWeight: number;
  starboardOffset: number;
  /** The risk weights of the balanced and safest alternatives; the shortest's is 0. */
  balancedRisk: number;
  safestRisk: number;
}

export const DEFAULT_PLAN: PlanOptions = {
  maxWork: 1_200_000,
  searchShare: 0.8,
  greed: 1.25,
  maxSideUnits: 4096,
  minCell: 10,
  corridorCell: 40,
  maxLeafMetres: 4000,
  minMargin: 2000,
  accessMetres: 500,
  maxDistance: 60_000,
  corridorDistance: 185_200,
  corridorWorkPerKm: 120_000,
  windowFactor: 3,
  minWindow: 3_600_000,
  harbourXte: 0,
  harbourMetres: 3000,
  harbourMargin: 300,
  berthMetres: 40,
  waitSwing: 60,
  waitSpacing: 500,
  riskWeight: 0,
  riskSplit: 0.1,
  riskCell: 80,
  preferReach: 30,
  preferWeight: 0.15,
  starboardOffset: 15,
  balancedRisk: 2,
  safestRisk: 10
};

/**
 * The limits for a trip `d` metres long: `opts`, or when `corridor` (the trip is planned in a
 * corridor, or past `maxDistance` where one can be made), the corridor's reach and work in
 * proportion to the trip.
 */
export function limitsFor(opts: PlanOptions, d: number, corridor: boolean): PlanOptions {
  if (!corridor) {
    return opts;
  }
  return {
    ...opts,
    maxDistance: Math.max(opts.maxDistance, opts.corridorDistance),
    maxWork: Math.max(opts.maxWork, Math.ceil((d / 1000) * opts.corridorWorkPerKm))
  };
}
