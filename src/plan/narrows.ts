import type { LonLat } from "../foundation/geo";
import type { SessionResult, Verdict } from "../oracle/contract";
import { crossable } from "../search/fallback";
import { strictMode } from "./modes";
import type { PlanOptions } from "./options";
import type { SearchOutcome } from "./search";
import { haversine } from "../foundation/geo";
import type { Session } from "../oracle/contract";
import { pull } from "../search/pull";
import { fairwayRoute } from "./fairway";
import { joined } from "./proof";
import { checkLeg, searchRoute } from "./search";
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
 * The way along the lines replaces a strict route the search found only when it is shorter by
 * more than this share: within it the search's route stands, kept to starboard of a two-way line
 * as preference lines keep it, where the lines' own way runs on them.
 */
const FAIRWAY_GAIN = 0.1;

const lengthOf = (c: readonly LonLat[]): number =>
  c.slice(1).reduce((sum, p, i) => sum + haversine(c[i] as LonLat, p), 0);

/**
 * The search's outcome, or the way along the charted lines (`fairway.ts`) when that passes and
 * the search found none, only a fallback, or a longer way: a swept fairway narrower than the
 * search's squares. Pulled straight where its legs pass.
 */
async function alongFairway(
  s: Session,
  ends: [LonLat, LonLat],
  o: SearchOutcome,
  c: { st: Stage; maxWork: number }
): Promise<SearchOutcome> {
  const exhausted = (): boolean => s.work() >= c.maxWork;
  const f = fairwayRoute(s, ends, {
    rule: c.st.rule,
    draft: c.st.opts.preferDraft,
    reach: c.st.opts.accessMetres,
    exhausted
  });
  // The search's work and this session's together.
  const work = o.work + s.work();
  const better =
    !o.ok ||
    o.fallback !== undefined ||
    (f !== undefined && lengthOf(f) < (1 - FAIRWAY_GAIN) * lengthOf(o.coordinates));
  if (!f || !better || exhausted()) {
    return { ...o, work };
  }
  const pulled = await pull(
    f,
    (p, q) => checkLeg(s, p, q),
    { exhausted, pause: () => s.pause() },
    c.st.rule
  );
  const coordinates = pulled === "work" ? f : pulled;
  return { ok: true, coordinates, direct: o.direct, squares: o.squares, work: o.work + s.work() };
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
  const pilotage = st.api.features?.includes("pilotage") === true;
  const search = { ...st.opts, ...opts, wideMargin: wideMargin(st, xteLimit) };
  const params = { ...st.params, xteLimit: st.opts.harbourXte };
  const searched = await st.api.session(params, st.signal, async (s) => {
    const o = await searchRoute(s, ends[0], ends[1], search, st.rule, st.fallback);
    // Without pilotage the lines are followed in the search's own session.
    return pilotage ? o : alongFairway(s, ends, { ...o, work: 0 }, { st, maxWork: budget });
  });
  if (!searched.ok) {
    return searched;
  }
  // With pilotage, along the lines in a session of its own: in swept water at the boat's
  // pilotage buffer, while the search's squares were asked once each at the harbour corridor.
  const narrow = pilotage
    ? await st.api.session({ ...params, pilotage }, st.signal, (s) =>
        alongFairway(s, ends, searched.value, { st, maxWork: budget - searched.value.work })
      )
    : searched;
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
  return withParts(st, { ...n, direct, work }, split.value.wide, { xteLimit, pilotage }, budget);
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
  c: { xteLimit: number | undefined; pilotage: boolean },
  budget: number
): Promise<SessionResult<Main>> {
  const parts = narrowParts(n.coordinates, wide, c.xteLimit, st.opts.harbourXte, n.fallback).map(
    (p) => (c.pilotage && p.kind === "narrows" ? { ...p, pilotage: true as const } : p)
  );
  let final = parts;
  let work = n.work;
  // A fallback route keeps its own pulling, and a route kept to lines its price for them.
  const bends = parts.some((p) => p.kind === "route" && p.coordinates.length > 2);
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
 * The `route` parts pulled straight at the request's corridor (`search/pull.ts`): priced by
 * squares, the search's route keeps short legs along the edge of narrow water, which a leg the
 * request's corridor passes needs not. A part's ends stay, where it meets a narrows part.
 */
function straightened(
  st: Stage,
  parts: Part[],
  budget: number
): Promise<SessionResult<{ parts: Part[]; work: number }>> {
  return st.api.session(
    st.params,
    st.signal,
    async (s): Promise<{ parts: Part[]; work: number }> => {
      const out: Part[] = [];
      for (const p of parts) {
        if (p.kind !== "route" || p.coordinates.length <= 2) {
          out.push(p);
          continue;
        }
        const pulled = await pull(
          p.coordinates,
          (a, b) => checkLeg(s, a, b),
          { exhausted: () => s.work() >= budget, pause: () => s.pause() },
          st.rule
        );
        out.push(pulled === "work" ? p : { ...p, coordinates: pulled });
      }
      return { parts: out, work: s.work() };
    }
  );
}
