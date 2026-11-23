/** Limits of one plan (plan §6). Work is counted in signalk-underkeel's work units, never timed. */
export interface PlanOptions {
  /**
   * Work one plan may do at least, search and pulling together; sized for about 3 s on a
   * Raspberry Pi 4. The plugin's setting; a longer trip may do more (`workPerKm`).
   */
  maxWork: number;
  /**
   * ...and a trip in the chart box may do this much per km of its straight distance, if that is
   * more: a longer trip meets more shore, and an archipelago passage most of all.
   */
  workPerKm: number;
  /**
   * Set by a stage, never by a request: a route the search must be shorter than is in hand, and
   * no path this many metres long or more is wanted (`search/astar.ts`, `SearchLimits.bound`).
   */
  lengthBound?: number;
  /** The share of `maxWork` after which the search stops and the plan is refused. */
  searchShare: number;
  /**
   * A*'s heuristic weight (weighted A*), for far fewer squares classified. Unsteered, the
   * search's path costs at most this many times the cheapest before string pulling; a steered
   * search's guide may overestimate, so its path has no such bound. 1 is plain A*.
   */
  greed: number;
  /**
   * Steering (`steer.ts`): the coarse pass cuts squares no finer than this, metres, at this
   * heuristic weight; its path orders the search. It may use this share of the search's work;
   * 0 turns steering off. The fallback's guide counts each metre of the path through a coarse
   * square that may hold no way through as `steerRisk` metres: the risk it will likely cross.
   */
  steerCell: number;
  steerGreed: number;
  steerShare: number;
  steerRisk: number;
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
   * The route passable now (`timing.ts`): when no route passes as the boat may meet the water
   * anywhere in the verdict window, the search asks again at the time the boat can be at each
   * square on a route at most this many times the straight distance (and at least the straight
   * distance plus `accessMetres` at each end).
   */
  nowReach: number;
  /** ...for a boat this share faster or slower than the request's speed. */
  timingSlack: number;
  /**
   * An end the corridor cannot reach is planned out to open water in a harbour stage, at
   * this cross-track limit (the planning API's buffer alone at 0), metres.
   */
  harbourXte: number;
  /**
   * Narrows (`narrows.ts`, plan §4.1 step 14): the main search runs at the harbour corridor
   * (`harbourXte`), and water only that corridor passes, not the request's, costs
   * `narrowWeight` more per metre. Off: every leg but a harbour stage's keeps to the request's
   * corridor.
   */
  narrows: boolean;
  narrowWeight: number;
  /**
   * Set by narrows for its search alone: the request's corridor less the session's, metres. A
   * square whose box grown by it does not pass is narrow water. 0: no narrow water.
   */
  wideMargin: number;
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
   * A charted anchorage or a user's waiting point this far off the route is reached by a
   * detour from the route and back, metres.
   */
  waitReach: number;
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
  /** Keep to the lines at all: a request's `preferLines`; off, a plan is as without them. */
  preferLines: boolean;
  starboardOffset: number;
  /**
   * The request's draft, metres, when it gives one: a fairway's navigation line laid out for
   * less (`designDraft`) is not kept to. Absent, every line is.
   */
  preferDraft?: number;
  /** The risk weights of the balanced and safest alternatives; the shortest's is 0. */
  balancedRisk: number;
  safestRisk: number;
}

export const DEFAULT_PLAN: PlanOptions = {
  maxWork: 1_200_000,
  workPerKm: 100_000,
  searchShare: 0.8,
  greed: 1.25,
  steerCell: 200,
  steerGreed: 3,
  steerShare: 0.15,
  steerRisk: 100,
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
  nowReach: 1.3,
  timingSlack: 0.2,
  harbourXte: 0,
  narrows: true,
  narrowWeight: 1,
  wideMargin: 0,
  harbourMetres: 3000,
  harbourMargin: 300,
  berthMetres: 40,
  waitSwing: 60,
  waitSpacing: 500,
  waitReach: 1852,
  riskWeight: 0,
  riskSplit: 0.1,
  riskCell: 80,
  preferReach: 50,
  preferWeight: 0.15,
  preferLines: false,
  starboardOffset: 15,
  balancedRisk: 2,
  safestRisk: 10
};

/**
 * The limits for a trip `d` metres long: `opts` with work in proportion to the trip where that is
 * more, or when `corridor` (the trip is planned in a corridor, or past `maxDistance` where one can
 * be made), the corridor's reach and work. Work grows with the distance, never with time taken,
 * so a request gives the same answer on any machine.
 */
export function limitsFor(opts: PlanOptions, d: number, corridor: boolean): PlanOptions {
  const perKm = corridor ? opts.corridorWorkPerKm : opts.workPerKm;
  const maxWork = Math.max(opts.maxWork, Math.ceil((d / 1000) * perKm));
  if (!corridor) {
    return maxWork === opts.maxWork ? opts : { ...opts, maxWork };
  }
  return { ...opts, maxDistance: Math.max(opts.maxDistance, opts.corridorDistance), maxWork };
}

/** The work budget a plugin setting may give one plan: the settable range, units. */
export const WORK_SETTING = { min: 100_000, max: 100_000_000 };

/**
 * `opts` with the plugin's work setting, when it is a whole number of units in range; else
 * `opts` as they are, and why the setting was not used.
 */
export function withWorkSetting(
  opts: PlanOptions,
  setting: unknown
): { opts: PlanOptions; ignored?: string } {
  if (setting === undefined || setting === null) {
    return { opts };
  }
  const ok =
    typeof setting === "number" &&
    Number.isInteger(setting) &&
    setting >= WORK_SETTING.min &&
    setting <= WORK_SETTING.max;
  return ok
    ? { opts: { ...opts, maxWork: setting } }
    : {
        opts,
        ignored: `work budget must be a whole number from ${String(WORK_SETTING.min)} to ${String(WORK_SETTING.max)}; using ${String(opts.maxWork)}`
      };
}

/** `opts` with a request's own risk weight, preference for lines, narrows and draft for lines. */
export function requestOptions(
  opts: PlanOptions,
  input: { riskWeight?: number; preferLines?: boolean; narrows?: boolean; draft?: number }
): PlanOptions {
  return {
    ...opts,
    riskWeight: input.riskWeight ?? opts.riskWeight,
    preferLines: input.preferLines ?? opts.preferLines,
    narrows: input.narrows ?? opts.narrows,
    ...(input.draft !== undefined && { preferDraft: input.draft })
  };
}
