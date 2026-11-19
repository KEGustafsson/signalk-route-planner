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
  berthMetres: 40
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
