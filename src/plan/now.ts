import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { Staged } from "./stages";
import { stages } from "./stages";
import { WORK_LIMIT } from "./search";
import { joined } from "./proof";
import { newMet, timedApi } from "./timing";

type Stage = Parameters<typeof stages>[0];

/** Whether the offered route holds as the boat may meet the water anywhere in the verdict window, or only at its own timing. */
export type Holds = "trip" | "now";

const lengthOf = (points: readonly LonLat[]): number =>
  points.slice(1).reduce((s, b, i) => s + haversine(points[i] as LonLat, b), 0);

const AT_ITS_TIMING = "also at the water the boat meets on the way at its speed from the departure";

/** Tighter reaches tried after the first: the first, then once more from the route found. */
const NOW_PASSES = 2;

interface Trip {
  from: LonLat;
  to: LonLat;
  departure: number;
  latestDeparture?: number;
  speed: number;
  xteLimit?: number;
}

type Run = (reach: number, maxWork: number) => Promise<Staged>;
type Refused = Extract<Staged, { refusal: unknown }>;

/**
 * The stages (plan §4.1) asked about each square at the time the boat can be there
 * (`timing.ts`, plan §4.3 R3d). First at the trip's reach, the verdict window's: its route holds
 * however the boat keeps to its timing, and it passes wherever the trip-wide question did. When
 * it finds none, not for want of work, again at a reach near the straight distance: a route
 * found there is kept only when it is no longer than that reach, for which its windows hold, else
 * asked once more at its own length. A tighter reach gives each square a window within the
 * wider one's, so a route the wider search finds passes in the tighter one too: refused there,
 * none is passable now.
 */
export async function nowStages(
  st: Stage,
  input: Trip,
  window: number
): Promise<{ found: Staged; holds: Holds }> {
  const timing = {
    from: input.from,
    to: input.to,
    departure: input.departure,
    latest: Math.max(input.departure, input.latestDeparture ?? input.departure),
    speed: input.speed,
    slack: st.opts.timingSlack
  };
  // The first search's verdicts no water changes serve the tighter ones as they are.
  const met = newMet();
  const runWith =
    (record: boolean): Run =>
    (reach, maxWork) =>
      stages(
        {
          ...st,
          api: record
            ? timedApi(st.api, { ...timing, reach }, met)
            : timedApi(st.api, { ...timing, reach }, undefined, met),
          opts: { ...st.opts, maxWork }
        },
        input.from,
        input.to,
        input.xteLimit
      );
  const tripReach = (window / 1000) * input.speed;
  const first = await runWith(true)(tripReach, st.opts.maxWork);
  // Asked again only when some water it met could pass at another time: land stays land. A
  // request that may wait for the tide has the gate time it instead (plan §4.3, R3a).
  if (
    "error" in first ||
    first.ok ||
    first.refusal.reason === WORK_LIMIT ||
    met.waterBound === 0 ||
    input.latestDeparture !== undefined
  ) {
    return { found: first, holds: "trip" };
  }
  const d = haversine(input.from, input.to);
  const reach = Math.max(st.opts.nowReach * d, d + 2 * st.opts.accessMetres);
  return tighter(runWith(false), first, { reach, tripReach, maxWork: st.opts.maxWork });
}

/** The searches at reaches tighter than the trip's, after `first` found none. */
async function tighter(
  run: Run,
  first: Refused,
  r: { reach: number; tripReach: number; maxWork: number }
): Promise<{ found: Staged; holds: Holds }> {
  let reach = r.reach;
  let work = first.work;
  let squares = first.refusal.squares;
  for (let k = 0; k < NOW_PASSES && reach < r.tripReach; k++) {
    const left = r.maxWork - work;
    if (left <= 0) {
      return { found: limited(first, work, squares), holds: "trip" };
    }
    const again = await run(reach, left);
    if ("error" in again) {
      return { found: again, holds: "trip" };
    }
    work += again.work;
    if (!again.ok) {
      squares += again.refusal.squares;
      const reason =
        again.refusal.reason === WORK_LIMIT
          ? WORK_LIMIT
          : `${again.refusal.reason}, ${AT_ITS_TIMING}`;
      return {
        found: { ...again, refusal: { ...again.refusal, reason, work, squares }, work },
        holds: "trip"
      };
    }
    squares += again.squares;
    const length = lengthOf(joined(again.parts));
    if (length <= reach) {
      return { found: { ...again, work, squares }, holds: "now" };
    }
    reach = Math.min(r.tripReach, length * 1.1);
  }
  return {
    found: { ...first, refusal: { ...first.refusal, work, squares }, work },
    holds: "trip"
  };
}

function limited(r: Refused, work: number, squares: number): Staged {
  return { ...r, refusal: { ...r.refusal, reason: WORK_LIMIT, work, squares }, work };
}
