import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { PlanningApiV1, Reply } from "../oracle/contract";
import type { PlanOptions } from "./options";
import type { Preparer } from "./prepare";

/**
 * The index of a trip's region asked for ahead of its plan (`POST /prepare`, plan §5). The first
 * plan of a region waits for signalk-underkeel to download and build that region's index. The
 * panel asks for it as soon as a route is picked, so the build runs while the route's options
 * are chosen, and the plan waits for what is left of it.
 */

/** How long `warmed` waits for an index before it answers that one is being built, ms. */
export const WARM_WAIT_MS = 200;

/** The trip of a plan request: what its index is prepared for. */
export interface Trip {
  from: LonLat;
  to: LonLat;
  draft?: number | undefined;
}

const reply = (status: number, state: "ready" | "preparing" | "none"): Reply => ({
  status,
  body: { state }
});

const waited = (ms: number): Promise<"waiting"> =>
  new Promise((resolve) => setTimeout(() => resolve("waiting"), ms).unref?.());

/**
 * Starts what a plan of `trip` would wait for first: an index its provider `found` holds, reads
 * back from disk or builds for the trip's region, as `Preparer.forTrip` asks for it. Answers
 * within `waitMs`: 200 `ready` when an index serves the trip, 202 `preparing` while one is built
 * for it, the provider's refusal as it gives it. Nothing is started, and the answer is `none`,
 * for a trip a plan asks no index for: its ends at one point, or further apart than
 * `maxDistance` (a trip that far is planned in a corridor, whose survey and band take minutes to
 * download: not begun for a route only looked at). Nor while another trip's index is built:
 * signalk-underkeel builds one index at a time, and a second one asked for ahead would hold back
 * the plan of the first. A request for the trip being built joins its build.
 */
export async function warmed(
  found: PlanningApiV1,
  trip: Trip,
  stop: AbortSignal,
  preparer: Preparer,
  opts: PlanOptions,
  waitMs = WARM_WAIT_MS
): Promise<Reply> {
  const dist = haversine(trip.from, trip.to);
  if (!(dist >= 1 && dist <= opts.maxDistance)) {
    return reply(200, "none");
  }
  if (preparer.busy && !preparer.building(trip.from, trip.to, trip.draft)) {
    return reply(200, "none");
  }
  const asked = preparer
    .forTrip(found, trip.from, trip.to, stop, trip.draft)
    .catch((err: Error): Reply => ({ status: 503, body: { errors: [err.message] } }));
  const r = await Promise.race([asked, waited(waitMs)]);
  if (r === "waiting") {
    return reply(202, "preparing");
  }
  if ("version" in r) {
    return reply(200, "ready");
  }
  const building = (r.body as { preparing?: unknown } | null)?.preparing === true;
  return building ? reply(202, "preparing") : r;
}
