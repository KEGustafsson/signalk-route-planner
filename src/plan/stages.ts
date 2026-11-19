import type { LonLat } from "../foundation/geo";
import type { PlanningApiV1, SessionParams, SessionResult, Verdict } from "../oracle/contract";
import type { PassRule } from "../search/passes";
import type { PlanOptions } from "./options";
import { same } from "./proof";
import type { SearchOutcome } from "./search";
import { searchRoute, WORK_LIMIT } from "./search";

/**
 * The stages of one plan (plan §4.1, harbour stage). The main search runs at the request's
 * corridor. When it cannot join the start or the destination, because the end lies in a
 * harbour narrower than that corridor, a harbour stage plans that end out to free water at
 * the narrow `harbourXte` corridor, in a session of its own, and the main search runs again
 * between the handover points. Each part is proved at its own corridor (`proof.ts`).
 */

export interface Part {
  kind: "harbour" | "route";
  /** For a harbour part: the end it leaves from or arrives at. */
  end?: "start" | "end";
  coordinates: LonLat[];
  /** The cross-track limit the part was searched at and is proved at; absent: the default. */
  xteLimit?: number;
  /** Set when no route passed and this part is the lowest risk-weighted route: why none passed. */
  fallback?: string;
  /** The inner point of the part's berth leg, from or to the end point. */
  berth?: LonLat;
}

export type Staged =
  | { ok: true; parts: Part[]; direct: Verdict; work: number; squares: number }
  | { ok: false; refusal: Extract<SearchOutcome, { ok: false }>; direct: Verdict; work: number }
  | { ok: false; status: number; error: string };

interface Stage {
  api: PlanningApiV1;
  params: SessionParams;
  signal: AbortSignal;
  opts: PlanOptions;
  rule: PassRule;
  fallback: boolean;
}

const routePart = (o: Extract<SearchOutcome, { ok: true }>, xteLimit?: number): Part => ({
  kind: "route",
  coordinates: o.coordinates,
  ...(xteLimit !== undefined && { xteLimit }),
  ...(o.fallback !== undefined && { fallback: o.fallback })
});

/** Handovers a harbour stage tries, most on the way first. */
const MAX_HANDOVERS = 3;

type HarbourFound =
  | { found: Extract<SearchOutcome, { ok: true }>; handover: LonLat; work: number }
  | { refused: string; work: number };

/** The harbour stage at one end: a route from `point` to the first handover it reaches. */
function harbourStage(
  st: Stage,
  end: "start" | "end",
  point: LonLat,
  candidates: LonLat[],
  budget: number
) {
  const opts = { ...st.opts, maxWork: budget };
  return st.api.session<HarbourFound>(
    { ...st.params, xteLimit: st.opts.harbourXte },
    st.signal,
    async (s) => {
      // Each handover in a small region of its own: it bounds what a fallback search crosses.
      const search = { ...opts, minMargin: opts.harbourMargin, harbourMetres: 0 };
      let reason = "no handover";
      for (const h of candidates.slice(0, MAX_HANDOVERS)) {
        const [a, b]: [LonLat, LonLat] = end === "start" ? [point, h] : [h, point];
        const o = await searchRoute(s, a, b, search, st.rule, st.fallback, opts.berthMetres);
        if (o.ok) {
          return { found: o, handover: h, work: s.work() };
        }
        reason = o.reason;
        if (/work limit/.test(o.reason)) {
          break;
        }
      }
      return { refused: reason, work: s.work() };
    }
  );
}

function harbourPart(end: "start" | "end", o: Extract<SearchOutcome, { ok: true }>, xte: number) {
  const berth = end === "start" ? o.berths?.start : o.berths?.end;
  return {
    kind: "harbour" as const,
    end,
    coordinates: o.coordinates,
    xteLimit: xte,
    ...(o.fallback !== undefined && { fallback: o.fallback }),
    ...(berth && { berth })
  };
}

type Refused = Extract<SearchOutcome, { ok: false }>;
type Ends = Partial<Record<"start" | "end", { part: Part; handover: LonLat }>>;

/** The harbour stage at each end the main search could not join (`o.stuck`). */
async function harbours(
  st: Stage,
  o: Refused,
  stuck: NonNullable<Refused["stuck"]>,
  points: [LonLat, LonLat]
): Promise<{ ends: Ends; work: number; squares: number } | Exclude<Staged, { ok: true }>> {
  const [from, to] = points;
  let work = o.work;
  let squares = o.squares;
  const ends: Ends = {};
  for (const end of ["start", "end"] as const) {
    const candidates = stuck[end];
    if (!candidates) {
      continue;
    }
    // Every stage draws on the plan's one budget, `maxWork`.
    const h = await harbourStage(
      st,
      end,
      end === "start" ? from : to,
      candidates,
      st.opts.maxWork - work
    );
    if (!h.ok) {
      return h;
    }
    work += h.value.work;
    if ("refused" in h.value) {
      const what = end === "start" ? "start" : "destination";
      const reason = `${o.reason}; the harbour stage found no way out from the ${what} at xte ${st.opts.harbourXte} m: ${h.value.refused}`;
      return { ok: false, refusal: { ...o, reason, work }, direct: o.direct, work };
    }
    squares += h.value.found.squares;
    ends[end] = {
      part: harbourPart(end, h.value.found, st.opts.harbourXte),
      handover: h.value.handover
    };
  }
  return { ends, work, squares };
}

/**
 * When a harbour stage finds no way out and the request asked for `fallback`: the whole route
 * in fallback, its risky legs marked, on the work that is left; else the harbour refusal.
 */
async function lastResort(
  st: Stage,
  ends: [LonLat, LonLat],
  refused: Extract<Staged, { refusal: unknown }>,
  xteLimit?: number
): Promise<Staged> {
  const opts = { ...st.opts, harbourMetres: 0, maxWork: st.opts.maxWork - refused.work };
  const whole = await st.api.session(st.params, st.signal, (s) =>
    searchRoute(s, ends[0], ends[1], opts, st.rule, st.fallback)
  );
  if (!whole.ok || !whole.value.ok) {
    return refused;
  }
  return {
    ok: true,
    parts: [routePart(whole.value, xteLimit)],
    direct: refused.direct,
    work: refused.work + whole.value.work,
    squares: whole.value.squares
  };
}

/** The main search, then harbour stages for the ends it could not join, then the main again. */
export async function stages(
  st: Stage,
  from: LonLat,
  to: LonLat,
  xteLimit?: number
): Promise<Staged> {
  const run = (a: LonLat, b: LonLat, opts: Partial<PlanOptions>) =>
    st.api.session(st.params, st.signal, (s) =>
      searchRoute(s, a, b, { ...st.opts, ...opts }, st.rule, st.fallback)
    );
  const first = await run(from, to, {});
  if (!first.ok) {
    return first;
  }
  const o = first.value;
  if (o.ok) {
    return {
      ok: true,
      parts: [routePart(o, xteLimit)],
      direct: o.direct,
      work: o.work,
      squares: o.squares
    };
  }
  if (!o.stuck) {
    return { ok: false, refusal: o, direct: o.direct, work: o.work };
  }
  const h = await harbours(st, o, o.stuck, [from, to]);
  if (!("ends" in h)) {
    return "refusal" in h && st.fallback ? lastResort(st, [from, to], h, xteLimit) : h;
  }
  return between(st, o, h, [from, to], xteLimit, run);
}

type Run = (
  a: LonLat,
  b: LonLat,
  opts: Partial<PlanOptions>
) => Promise<SessionResult<SearchOutcome>>;

/** After the harbour stages: the main search between their handovers, within the one budget. */
async function between(
  st: Stage,
  o: Refused,
  h: { ends: Ends; work: number; squares: number },
  points: [LonLat, LonLat],
  xteLimit: number | undefined,
  run: Run
): Promise<Staged> {
  const [from, to] = points;
  let work = h.work;
  const limit = (): Staged => ({
    ok: false,
    refusal: { ...o, reason: WORK_LIMIT, work },
    direct: o.direct,
    work
  });
  if (work >= st.opts.maxWork) {
    return limit();
  }
  const a = h.ends.start?.handover ?? from;
  const b = h.ends.end?.handover ?? to;
  const harbourParts = (route: Part[]): Part[] => [
    ...(h.ends.start ? [h.ends.start.part] : []),
    ...route,
    ...(h.ends.end ? [h.ends.end.part] : [])
  ];
  // Both ends hand over at the same point: the harbour parts meet there, with no route between.
  if (h.ends.start && h.ends.end && same(a, b)) {
    return { ok: true, parts: harbourParts([]), direct: o.direct, work, squares: h.squares };
  }
  const inner = await run(a, b, { maxWork: st.opts.maxWork - work });
  if (!inner.ok) {
    return inner;
  }
  work += inner.value.work;
  if (!inner.value.ok) {
    return { ok: false, refusal: { ...inner.value, work }, direct: o.direct, work };
  }
  // Every stage draws on the one budget: the plan answers with the limit once it is spent.
  if (work >= st.opts.maxWork) {
    return limit();
  }
  const parts = harbourParts([routePart(inner.value, xteLimit)]);
  return { ok: true, parts, direct: o.direct, work, squares: h.squares + inner.value.squares };
}
