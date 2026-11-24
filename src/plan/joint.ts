import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { Session, SessionResult, Verdict } from "../oracle/contract";
import { crossingRule, strictRule, tautWithin } from "../search/taut";
import { same } from "./proof";
import { checkLeg } from "./search";
import type { Part, Stage } from "./stages";

/**
 * Joints (plan §4.1, harbour stage). A harbour stage plans an end out to a handover, a patch of
 * free water the main search named, and the main search then runs between the handovers: each
 * is the shortest of its own, but where they meet the route turns at the handover whichever way
 * the two came, a dog-leg where the harbour's way out and the route's way on point apart. Here
 * the harbour part is drawn tight together with the route's first stretch past the handover
 * (`search/taut.ts`), at the harbour corridor, and takes that stretch over: the handover moves
 * along the route's own leg, so the rest of that leg stays a part of a leg already checked.
 * Every new leg is checked in the harbour corridor's session and proved there (invariant 1).
 */

/** How far along the route's leg past a handover the harbour part may reach, metres. */
export const JOINT_REACH = 500;

/** The work one joint may take, underkeel work units: a few tens of leg checks. */
const JOINT_WORK = 60_000;

const lengthOf = (c: readonly LonLat[]): number =>
  c.slice(1).reduce((sum, p, i) => sum + haversine(c[i] as LonLat, p), 0);

/** The point `d` metres from `a` toward `b`, or `b` when it is no farther. */
function toward(a: LonLat, b: LonLat, d: number): LonLat {
  const len = haversine(a, b);
  if (len <= d) {
    return b;
  }
  const t = d / len;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** `points` drawn tight in `s` under the harbour part's own price, when that is shorter. */
async function tightened(
  s: Session,
  st: Stage,
  harbour: Part,
  points: LonLat[],
  maxWork: number
): Promise<LonLat[] | undefined> {
  const check = (a: LonLat, b: LonLat): Verdict => checkLeg(s, a, b);
  // A harbour part found only by the fallback crosses water that does not pass: priced as its
  // search priced it, so no leg is drawn into worse water than it replaced.
  const rule = harbour.fallback === undefined ? strictRule(st.rule) : crossingRule(st.rule);
  const tight = await tautWithin(points, check, { session: s, maxWork }, rule);
  return lengthOf(tight) < lengthOf(points) - 1 ? tight : undefined;
}

/**
 * The start's harbour part and the part after it with their joint eased: the harbour part, less
 * its berth leg, drawn tight with the next part's first leg up to JOINT_REACH, which it takes
 * over. Unchanged when that is no shorter.
 */
async function easedStart(
  s: Session,
  st: Stage,
  [harbour, next]: [Part, Part],
  maxWork: number
): Promise<[Part, Part]> {
  const h = harbour.coordinates;
  const m = next.coordinates;
  const [first, second] = [m[0], m[1]];
  if (!first || !second || h.length < 2) {
    return [harbour, next];
  }
  // The berth leg, from the quay to the berth point, stays as it is.
  const lead = harbour.berth ? 1 : 0;
  const to = toward(first, second, JOINT_REACH);
  const tight = await tightened(s, st, harbour, [...h.slice(lead), to], maxWork);
  if (!tight) {
    return [harbour, next];
  }
  return [
    { ...harbour, coordinates: [...h.slice(0, lead), ...tight] },
    { ...next, coordinates: same(to, second) ? m.slice(1) : [to, ...m.slice(1)] }
  ];
}

/** As `easedStart`, for the part before the destination's harbour part and that part. */
async function easedEnd(
  s: Session,
  st: Stage,
  [prev, harbour]: [Part, Part],
  maxWork: number
): Promise<[Part, Part]> {
  const h = harbour.coordinates;
  const m = prev.coordinates;
  const [last, before] = [m[m.length - 1], m[m.length - 2]];
  if (!last || !before || h.length < 2) {
    return [prev, harbour];
  }
  const tail = harbour.berth ? 1 : 0;
  const from = toward(last, before, JOINT_REACH);
  const tight = await tightened(s, st, harbour, [from, ...h.slice(0, h.length - tail)], maxWork);
  if (!tight) {
    return [prev, harbour];
  }
  return [
    { ...prev, coordinates: same(from, before) ? m.slice(0, -1) : [...m.slice(0, -1), from] },
    { ...harbour, coordinates: [...tight, ...h.slice(h.length - tail)] }
  ];
}

const isHarbour = (p: Part | undefined, end: "start" | "end"): p is Part =>
  p?.kind === "harbour" && p.end === end;

/**
 * `parts` with the joint at each harbour part eased, on at most `budget` work in one session at
 * the harbour corridor, and the work it took. A part the harbour part took over whole is left out.
 */
export function eased(
  st: Stage,
  parts: Part[],
  budget: number
): Promise<SessionResult<{ parts: Part[]; work: number }>> {
  const params = { ...st.params, xteLimit: st.opts.harbourXte };
  return st.api.session(params, st.signal, async (s) => {
    const out = [...parts];
    const limit = (): number => s.work() + Math.min(JOINT_WORK, Math.max(0, budget - s.work()));
    const [h0, next] = [out[0], out[1]];
    if (isHarbour(h0, "start") && next && next.kind !== "harbour") {
      [out[0], out[1]] = await easedStart(s, st, [h0, next], limit());
    }
    const n = out.length;
    const [prev, h1] = [out[n - 2], out[n - 1]];
    if (isHarbour(h1, "end") && prev && prev.kind !== "harbour") {
      [out[n - 2], out[n - 1]] = await easedEnd(s, st, [prev, h1], limit());
    }
    return { parts: out.filter((p) => p.coordinates.length > 1), work: s.work() };
  });
}
