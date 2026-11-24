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
 * The first `reach` metres of the path through `parts`, each meeting the next at its first point:
 * the points in it, the point `reach` metres along (`cut`), and the parts left past the cut, the
 * first of them starting there. A part the stretch covers whole is not among those left; parts
 * shorter than `reach` in all are the stretch whole, cut at their last point, with none left.
 */
function head(
  parts: readonly Part[],
  reach: number
): { points: LonLat[]; cut: LonLat; rest: Part[] } | undefined {
  const points: LonLat[] = [];
  let left = reach;
  for (let k = 0; k < parts.length; k++) {
    const c = (parts[k] as Part).coordinates;
    for (let i = 1; i < c.length; i++) {
      const [a, b] = [c[i - 1] as LonLat, c[i] as LonLat];
      if (points.length === 0) {
        points.push(a);
      }
      const len = haversine(a, b);
      if (len >= left) {
        const cut = toward(a, b, left);
        const tail = same(cut, b) ? c.slice(i + 1) : c.slice(i);
        // Cut at this part's last point: the next part starts there already.
        const own = tail.length > 0 ? [{ ...(parts[k] as Part), coordinates: [cut, ...tail] }] : [];
        return { points, cut, rest: [...own, ...parts.slice(k + 1)] };
      }
      left -= len;
      points.push(b);
    }
  }
  // The parts end within the reach: the stretch is all of them, cut at their last point.
  const cut = points.pop();
  return cut ? { points, cut, rest: [] } : undefined;
}

/** `part` with its coordinates in the reverse order. */
const reversed = (part: Part): Part => ({ ...part, coordinates: [...part.coordinates].reverse() });

/**
 * The start's harbour part and the parts after it with their joint eased: the harbour part, less
 * its berth leg, drawn tight with the route's first JOINT_REACH metres past the handover, which
 * it takes over, across as many parts as those metres reach: a narrows part a few metres long
 * at the handover is no wall to the easing. Unchanged when that is no shorter.
 */
async function easedStart(
  s: Session,
  st: Stage,
  harbour: Part,
  after: Part[],
  maxWork: number
): Promise<[Part, Part[]]> {
  const h = harbour.coordinates;
  const stretch = head(after, JOINT_REACH);
  if (!stretch || h.length < 2) {
    return [harbour, after];
  }
  // The berth leg, from the quay to the berth point, stays as it is.
  const lead = harbour.berth ? 1 : 0;
  const points = [...h.slice(lead), ...stretch.points.slice(1), stretch.cut];
  const tight = await tightened(s, st, harbour, points, maxWork);
  if (!tight) {
    return [harbour, after];
  }
  return [{ ...harbour, coordinates: [...h.slice(0, lead), ...tight] }, stretch.rest];
}

/** As `easedStart`, for the parts before the destination's harbour part and that part. */
async function easedEnd(
  s: Session,
  st: Stage,
  before: Part[],
  harbour: Part,
  maxWork: number
): Promise<[Part[], Part]> {
  const back = await easedStart(
    s,
    st,
    { ...reversed(harbour), berth: harbour.berth },
    [...before].reverse().map(reversed),
    maxWork
  );
  return [[...back[1]].reverse().map(reversed), { ...reversed(back[0]), berth: harbour.berth }];
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
    const limit = (): number => s.work() + Math.min(JOINT_WORK, Math.max(0, budget - s.work()));
    let out = [...parts];
    const h0 = out[0];
    if (isHarbour(h0, "start") && out.length > 1 && out[1]?.kind !== "harbour") {
      const inner = out.slice(1).filter((p) => p.kind !== "harbour");
      const [h, rest] = await easedStart(s, st, h0, inner, limit());
      out = [h, ...rest, ...out.slice(1 + inner.length)];
    }
    const h1 = out[out.length - 1];
    if (isHarbour(h1, "end") && out.length > 1 && out[out.length - 2]?.kind !== "harbour") {
      const lead = isHarbour(out[0], "start") ? 1 : 0;
      const inner = out.slice(lead, -1);
      const [rest, h] = await easedEnd(s, st, inner, h1, limit());
      out = [...out.slice(0, lead), ...rest, h];
    }
    return { parts: out.filter((p) => p.coordinates.length > 1), work: s.work() };
  });
}
