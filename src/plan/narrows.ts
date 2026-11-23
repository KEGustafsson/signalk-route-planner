import type { LonLat } from "../foundation/geo";
import type { SessionResult, Verdict } from "../oracle/contract";
import { crossable } from "../search/fallback";
import { strictMode } from "./modes";
import type { PlanOptions } from "./options";
import type { SearchOutcome } from "./search";
import { haversine } from "../foundation/geo";
import type { Session } from "../oracle/contract";
import { pull } from "../search/pull";
import type { PassRule } from "../search/passes";
import { passes } from "../search/passes";
import { bandAroundTurns, bandShortest } from "../search/band";
import { settledCheck } from "../search/field";
import type { TautRule } from "../search/taut";
import { tautWithin } from "../search/taut";
import { fairwayRoute } from "./fairway";
import { joined } from "./proof";
import { checkLeg, searchRoute, WORK_LIMIT } from "./search";
import type { Part, Stage } from "./stages";

/**
 * Narrows (plan §4.1 step 14): a sound or a fairway narrower than the request's corridor. The
 * main search runs strictly at the harbour corridor (`harbourXte`), and water only that
 * corridor passes, not the request's, costs `narrowWeight` more per metre
 * (`search/narrow.ts`): the route keeps the request's corridor wherever the way round costs
 * less, and crosses narrow water where it is the way. Its legs the request's corridor passes
 * are `route` parts at that corridor, the others `narrows` parts at the harbour corridor; each
 * part is proved at its own corridor (`proof.ts`).
 */

/** A main search's outcome; a route through narrows carries its parts. */
type Found = Extract<SearchOutcome, { ok: true }>;
export type Main = SearchOutcome & { parts?: Part[] };

/** The request's corridor less the harbour corridor, metres. */
const wideMargin = (st: Stage, xteLimit: number | undefined): number =>
  (xteLimit ?? st.api.defaults().xteLimit) - st.opts.harbourXte;

/**
 * Whether narrows apply: on, the shortest route (a risk cost asks for room, which a narrow
 * corridor gives away), and the request's corridor wider than the harbour corridor.
 */
export function narrowsOn(st: Stage, xteLimit: number | undefined): boolean {
  return st.opts.narrows && st.opts.riskWeight === 0 && wideMargin(st, xteLimit) > 0;
}

/** Consecutive legs grouped by whether the request's corridor passes them, as parts. */
export function narrowParts(
  route: readonly LonLat[],
  wide: readonly boolean[],
  xteLimit: number | undefined,
  harbourXte: number,
  fallback?: string
): Part[] {
  const parts: Part[] = [];
  let k = 0;
  while (k < wide.length) {
    let j = k;
    while (j + 1 < wide.length && wide[j + 1] === wide[k]) {
      j++;
    }
    const coordinates = route.slice(k, j + 2);
    const part: Part = wide[k]
      ? { kind: "route", coordinates, ...(xteLimit !== undefined && { xteLimit }) }
      : { kind: "narrows", coordinates, xteLimit: harbourXte };
    parts.push(fallback === undefined ? part : { ...part, fallback });
    k = j + 1;
  }
  return parts;
}

/**
 * Each leg of `route` checked at the request's corridor, and the direct line there. A leg of a
 * fallback route that crosses water the fallback may cross holds there too: only what closes it
 * (land, no chart, a hard rule) keeps it to the harbour corridor.
 */
function atRequestCorridor(
  st: Stage,
  route: readonly LonLat[],
  ends: [LonLat, LonLat],
  fallback: boolean
): Promise<SessionResult<{ wide: boolean[]; direct: Verdict; work: number }>> {
  const joins = strictMode(st.rule).joins;
  const holds = (v: Verdict): boolean => joins(v) || (fallback && crossable(v));
  return st.api.session(st.params, st.signal, (s) => {
    const wide = route.slice(1).map((b, i) => holds(checkLeg(s, route[i] as LonLat, b)));
    return Promise.resolve({ wide, direct: checkLeg(s, ends[0], ends[1]), work: s.work() });
  });
}

/**
 * With preference lines, the way along the lines replaces a strict route the search found only
 * when it is shorter by more than this share: within it the search's route stands, kept to
 * starboard of a two-way line as preference lines keep it, where the lines' own way runs on them.
 * Without them the shorter stands.
 */
const FAIRWAY_GAIN = 0.1;

/**
 * How far from the lines an end of the way along them may lie, metres: an end out of a harbour
 * or off a fairway is joined to the nearest points of the lines within it, each joining leg
 * checked as every other leg is, so one crossing land is not taken.
 */
const LINE_REACH = 2000;

/**
 * A leg's check for the strict passes here, which read no more of a verdict than whether
 * `rule` passes it: settled on the session's raster where that says (`search/field.ts`), else
 * the route check's.
 */
const settled = (s: Session, rule: PassRule): ((p: LonLat, q: LonLat) => Verdict) =>
  settledCheck(s, rule, (p, q) => checkLeg(s, p, q));

/** A strict route's price for `taut`: its length where `rule` passes a leg; nowhere else. */
const strictTaut = (rule: PassRule): TautRule => ({
  cost: (v) => (passes(v, rule) ? 1 : Infinity),
  rank: (v) => (passes(v, rule) ? 0 : 3),
  // The lines' way and a route's straightened parts turn between long legs.
  cutCorners: true,
  // Shortest mode (`narrowsOn`): every passing leg alike.
  passing: true
});

const lengthOf = (c: readonly LonLat[]): number =>
  c.slice(1).reduce((sum, p, i) => sum + haversine(c[i] as LonLat, p), 0);

/**
 * The way along the charted lines (`fairway.ts`), every leg passing, pulled straight and its
 * corners cut as far as the water lets it (`search/taut.ts`): a swept fairway narrower than the
 * search's squares. None when no lines join the ends, no way along them passes, or the work ran
 * out.
 */
async function fairwayCandidate(
  s: Session,
  ends: [LonLat, LonLat],
  c: { st: Stage; maxWork: number }
): Promise<LonLat[] | undefined> {
  const exhausted = (): boolean => s.work() >= c.maxWork;
  const f = fairwayRoute(s, ends, {
    rule: c.st.rule,
    draft: c.st.opts.preferDraft,
    reach: Math.max(c.st.opts.accessMetres, LINE_REACH),
    exhausted
  });
  if (!f || exhausted()) {
    return undefined;
  }
  const check = settled(s, c.st.rule);
  const pulled = await pull(f, check, { exhausted, pause: () => s.pause() }, c.st.rule);
  // The lines turn where they meet: their corners cut, as far as the water lets the route.
  return pulled === "work"
    ? f
    : tautWithin(pulled, check, { session: s, maxWork: c.maxWork }, strictTaut(c.st.rule));
}

/**
 * How much longer than the lines' way the search's may be and still stand: not at all, the
 * shorter stands, but with preference lines FAIRWAY_GAIN, so a route kept to starboard of a
 * two-way line stays where the lines' own way runs on it.
 */
const slack = (st: Stage): number => (st.opts.preferLines ? 1 / (1 - FAIRWAY_GAIN) : 1);

/**
 * The search's outcome, or the way along the lines when that is in hand and the search found
 * none for a reason other than its work limit, only a fallback, or a way longer than the lines'
 * by more than its `slack`. A search cut short by the work limit refuses the plan (invariant 5).
 */
function shorter(
  o: SearchOutcome,
  f: LonLat[] | undefined,
  c: { slack: number; work: number }
): SearchOutcome {
  const work = c.work;
  const better =
    f !== undefined &&
    (o.ok
      ? o.fallback !== undefined || lengthOf(o.coordinates) > c.slack * lengthOf(f)
      : o.reason !== WORK_LIMIT);
  return better && f
    ? { ok: true, coordinates: f, direct: o.direct, squares: o.squares, work }
    : { ...o, work };
}

/**
 * A strict route made shorter on grids along it (`search/band.ts`), each way pulled and drawn
 * tight: first a band along the whole route, which finds the way round an islet the search's
 * squares led it past, then a fine grid round its turns, which finds a gap narrower than the
 * band's grid. Each is kept only when it is shorter and every leg passes in `s`, at its corridor;
 * each runs on half the work left, the route as it was when that runs out.
 */
async function refined(
  s: Session,
  route: LonLat[],
  c: { rule: PassRule; maxWork: number }
): Promise<LonLat[]> {
  const { rule } = c;
  const check = settled(s, rule);
  let best = route;
  for (const search of [bandShortest, bandAroundTurns]) {
    if (best.length < 3) {
      break;
    }
    const stop = s.work() + (c.maxWork - s.work()) / 2;
    const exhausted = (): boolean => s.work() >= stop;
    const band = await search(best, check, { exhausted, pause: () => s.pause() }, rule);
    if (!band) {
      break;
    }
    const limits = { exhausted: () => s.work() >= c.maxWork, pause: () => s.pause() };
    const pulled = await pull(band, check, limits, rule);
    const tight =
      pulled === "work"
        ? band
        : await tautWithin(pulled, check, { session: s, maxWork: c.maxWork }, strictTaut(rule));
    // Kept only when it is shorter and the route check itself passes every leg of it.
    const holds = (): boolean =>
      tight.slice(1).every((q, i) => passes(checkLeg(s, tight[i] as LonLat, q), rule));
    if (lengthOf(tight) < lengthOf(best) && holds()) {
      best = tight;
    }
  }
  return best;
}

/**
 * The main search from `a` to `b`, with narrows where they apply; `opts` over the stage's, its
 * `maxWork` the work this search may do in all. It runs at the harbour corridor, with the
 * fallback when one is asked for: every square and leg the request's corridor passes, the
 * narrow one passes too, so a search there has nothing to add. An end the harbour corridor
 * cannot join goes to its harbour stage from the free water the search names near it
 * (`stuck`); a refusal is the request corridor's direct line with the narrow search's reason.
 */
export async function mainSearch(
  st: Stage,
  ends: [LonLat, LonLat],
  opts: Partial<PlanOptions>,
  xteLimit: number | undefined
): Promise<SessionResult<Main>> {
  if (!narrowsOn(st, xteLimit)) {
    return st.api.session(st.params, st.signal, (s) =>
      searchRoute(s, ends[0], ends[1], { ...st.opts, ...opts }, st.rule, st.fallback)
    );
  }
  const budget = opts.maxWork ?? st.opts.maxWork;
  const search = { ...st.opts, ...opts, wideMargin: wideMargin(st, xteLimit) };
  const params = { ...st.params, xteLimit: st.opts.harbourXte };
  // The way along the lines first, then the search, in one session at the harbour corridor:
  // with the lines' way in hand the search looks only for a way that could stand against it,
  // no longer than its length times its slack.
  const narrow = await st.api.session(params, st.signal, async (s) => {
    const f = await fairwayCandidate(s, ends, { st, maxWork: budget });
    const bound = f && { lengthBound: slack(st) * lengthOf(f) };
    const o = await searchRoute(s, ends[0], ends[1], { ...search, ...bound }, st.rule, st.fallback);
    return shorter(o, f, { slack: slack(st), work: s.work() });
  });
  if (!narrow.ok) {
    return narrow;
  }
  const n = narrow.value;
  const route = n.ok ? n.coordinates : ends;
  const split = await atRequestCorridor(st, route, ends, n.ok && n.fallback !== undefined);
  if (!split.ok) {
    return split;
  }
  const { direct } = split.value;
  const work = n.work + split.value.work;
  if (!n.ok) {
    return { ok: true, value: { ...n, direct, work } };
  }
  return withParts(st, { ...n, direct, work }, split.value.wide, xteLimit, budget);
}

/**
 * The narrow search's route in its parts (`narrowParts`), a strict route's `route` parts pulled
 * straight at the request's corridor unless it keeps to lines; one `route` part is the route as
 * it is, without parts.
 */
async function withParts(
  st: Stage,
  n: Found,
  wide: boolean[],
  xteLimit: number | undefined,
  budget: number
): Promise<SessionResult<Main>> {
  const parts = narrowParts(n.coordinates, wide, xteLimit, st.opts.harbourXte, n.fallback);
  let final = parts;
  let work = n.work;
  // A fallback route keeps its own pulling, and a route kept to lines its price for them.
  const bends = parts.some((p) => p.coordinates.length > 2);
  if (n.fallback === undefined && !st.opts.preferLines && bends) {
    const straight = await straightened(st, parts, budget - work);
    if (!straight.ok) {
      return straight;
    }
    final = straight.value.parts;
    work += straight.value.work;
  }
  const value = { ...n, coordinates: joined(final), work };
  const one = final.length === 1 && final[0]?.kind === "route";
  return { ok: true, value: one ? value : { ...value, parts: final } };
}

/**
 * Each part drawn as short as its own corridor lets it: a `route` part pulled straight at the
 * request's corridor (`search/pull.ts`), since priced by squares the search's route keeps short
 * legs along the edge of narrow water, which a leg the request's corridor passes needs not; then
 * every part refined in a band along it (`refined`), a `narrows` part at the harbour corridor. A
 * part's ends stay, where it meets the next.
 */
async function straightened(
  st: Stage,
  parts: Part[],
  budget: number
): Promise<SessionResult<{ parts: Part[]; work: number }>> {
  const wide = await st.api.session(st.params, st.signal, async (s) => ({
    parts: await shortenParts(s, parts, "route", { st, budget }),
    work: s.work()
  }));
  if (!wide.ok || !wide.value.parts.some((p) => p.kind === "narrows" && p.coordinates.length > 2)) {
    return wide;
  }
  const narrow = await st.api.session(
    { ...st.params, xteLimit: st.opts.harbourXte },
    st.signal,
    async (s) => ({
      parts: await shortenParts(s, wide.value.parts, "narrows", {
        st,
        budget: budget - wide.value.work
      }),
      work: s.work()
    })
  );
  return narrow.ok
    ? { ok: true, value: { parts: narrow.value.parts, work: wide.value.work + narrow.value.work } }
    : narrow;
}

/** The parts of `kind`, each shortened in `s`, at their corridor; the others as they are. */
async function shortenParts(
  s: Session,
  parts: Part[],
  kind: Part["kind"],
  c: { st: Stage; budget: number }
): Promise<Part[]> {
  const { rule } = c.st;
  const out: Part[] = [];
  for (const p of parts) {
    if (p.kind !== kind || p.coordinates.length <= 2) {
      out.push(p);
      continue;
    }
    const check = settled(s, rule);
    let tight = p.coordinates;
    if (kind === "route") {
      const limits = { exhausted: () => s.work() >= c.budget, pause: () => s.pause() };
      const pulled = await pull(p.coordinates, check, limits, rule);
      tight =
        pulled === "work"
          ? p.coordinates
          : await tautWithin(pulled, check, { session: s, maxWork: c.budget }, strictTaut(rule));
    }
    out.push({ ...p, coordinates: await refined(s, tight, { rule, maxWork: c.budget }) });
  }
  return out;
}
