import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { PlanningApiV1, Verdict, Window } from "../oracle/contract";
import type { PassRule } from "../search/passes";
import { passes } from "../search/passes";
import type { Part } from "./stages";

/**
 * Tide gates (plan §4.3): when a route passes only at some states of the tide, the
 * earliest departure, up to the request's latest, at which every leg is passed in water
 * the check passes, as the boat reaches it. The planner never reads a tide table: it asks
 * the planning API about each gated leg over 15-minute windows, at the lowest water in each.
 */

/** The step departures and pass windows are taken in, ms: the water level forecast's. */
export const SLOT_MS = 15 * 60_000;

export interface GateInput {
  departure: number;
  latest: number;
  speed: number;
  probability?: number;
  draft?: number;
}

export type Timed =
  { ok: true; departure: number; gated: number[] } | { ok: false; reason: string };

interface Leg {
  a: LonLat;
  b: LonLat;
  xteLimit?: number;
  /** Time from departure to the leg's start and end, ms. */
  from: number;
  to: number;
}

/** The candidate's legs, in order, with when the boat reaches each after leaving. */
export function legsOf(parts: readonly Part[], speed: number): Leg[] {
  const legs: Leg[] = [];
  let t = 0;
  for (const p of parts) {
    for (let i = 1; i < p.coordinates.length; i++) {
      const a = p.coordinates[i - 1] as LonLat;
      const b = p.coordinates[i] as LonLat;
      const dt = (haversine(a, b) / speed) * 1000;
      legs.push({
        a,
        b,
        ...(p.xteLimit !== undefined && { xteLimit: p.xteLimit }),
        from: t,
        to: t + dt
      });
      t += dt;
    }
  }
  return legs;
}

/** Whether a verdict lets a strict plan through: passing, or marginal. */
const through = (v: Verdict, rule: PassRule): boolean => passes(v, rule) || v.status === "marginal";

/** The slot windows that cover [from, to), on the grid from `origin`. */
function slotsOver(origin: number, from: number, to: number): number[] {
  const out: number[] = [];
  const first = Math.floor((from - origin) / SLOT_MS);
  for (let k = first; origin + k * SLOT_MS < to; k++) {
    out.push(k);
  }
  return out;
}

const WORK = "timing the departure reached the work limit";

/**
 * Per gated leg, whether each slot of the horizon may be passed (index k: the window from
 * departure + k slots). A leg that passes at the lowest water of the whole horizon is not gated.
 * One session per corridor width, one after another: a session holds the request queue.
 */
async function passWindows(
  api: PlanningApiV1,
  g: GateInput,
  legs: readonly Leg[],
  horizon: Window,
  ctx: { rule: PassRule; signal: AbortSignal; budget: number }
): Promise<Map<number, boolean[]> | string> {
  const slots = Math.ceil((horizon.end - horizon.start) / SLOT_MS);
  const gated = new Map<number, boolean[]>();
  let work = 0;
  for (const width of new Set(legs.map((l) => l.xteLimit))) {
    const params = {
      departure: horizon.start,
      until: horizon.end,
      speed: g.speed,
      ...(width !== undefined && { xteLimit: width }),
      ...(g.probability !== undefined && { probability: g.probability }),
      ...(g.draft !== undefined && { draft: g.draft })
    };
    const r = await api.session(params, ctx.signal, async (s) => {
      for (const [i, leg] of legs.entries()) {
        if (leg.xteLimit !== width || through(s.segment(leg.a, leg.b, horizon), ctx.rule)) {
          continue;
        }
        const open: boolean[] = [];
        for (let k = 0; k < slots; k++) {
          if (work + s.work() >= ctx.budget) {
            return WORK;
          }
          const start = horizon.start + k * SLOT_MS;
          open.push(through(s.segment(leg.a, leg.b, { start, end: start + SLOT_MS }), ctx.rule));
          await s.pause();
        }
        gated.set(i, open);
      }
      return s.work();
    });
    if (!r.ok) {
      return r.error;
    }
    if (typeof r.value === "string") {
      return r.value;
    }
    work += r.value;
  }
  return gated;
}

/**
 * The earliest departure from `g.departure` to `g.latest`, on the slot grid, at which every
 * gated leg lies in windows it may be passed in, or why there is none. `budget` bounds the
 * planning API's work across the sessions it needs.
 */
export async function timeDeparture(
  api: PlanningApiV1,
  g: GateInput,
  parts: readonly Part[],
  ctx: { rule: PassRule; signal: AbortSignal; budget: number }
): Promise<Timed> {
  const legs = legsOf(parts, g.speed);
  const trip = legs[legs.length - 1]?.to ?? 0;
  const horizon: Window = { start: g.departure, end: g.latest + trip + SLOT_MS };
  const open = await passWindows(api, g, legs, horizon, ctx);
  if (typeof open === "string") {
    return { ok: false, reason: open };
  }
  const gated = [...open.keys()];
  for (let t = g.departure; t <= g.latest; t += SLOT_MS) {
    const clear = gated.every((i) => {
      const leg = legs[i] as Leg;
      const w = open.get(i) as boolean[];
      return slotsOver(g.departure, t + leg.from, t + leg.to).every((k) => w[k] === true);
    });
    if (clear) {
      return { ok: true, departure: t, gated };
    }
  }
  const at = new Date(g.latest).toISOString();
  return {
    ok: false,
    reason: `no departure up to ${at} passes leg${gated.length === 1 ? "" : "s"} ${gated.map((i) => i + 1).join(", ")} at any state of the water level the forecast gives`
  };
}
