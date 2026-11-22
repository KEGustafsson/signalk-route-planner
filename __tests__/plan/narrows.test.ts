import fc from "fast-check";
import { parsePlanRequest } from "../../src/api/plan-request";
import type { LonLat } from "../../src/foundation/geo";
import { haversine } from "../../src/foundation/geo";
import { narrowParts } from "../../src/plan/narrows";
import type { PlanInput } from "../../src/plan/plan";
import { plan } from "../../src/plan/plan";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { WORK_LIMIT } from "../../src/plan/search";
import type { Chart, Circle } from "../helpers/synthetic-oracle";
import { at, legStatus, syntheticApi, xy } from "../helpers/synthetic-oracle";

/**
 * Narrows (plan §4.1 step 14): the main search runs at the harbour corridor, and water only
 * that corridor passes costs `narrowWeight` more per metre, unless it lies on a charted line. A
 * sound narrower than the request's corridor is crossed where the way round costs more; its
 * legs are in `narrows` parts proved at the harbour corridor, the rest at the request's.
 */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");
const FROM = at(0, 0);
const TO = at(6000, 0);

/** Two islands of radius `r` across x = 3000, a sound 60 m wide between them on y = 0. */
function sound(r: number): Chart {
  return {
    obstacles: [
      { x: 3000, y: r + 30, r },
      { x: 3000, y: -(r + 30), r }
    ]
  };
}

interface Body {
  reason?: string;
  length: number;
  route: { coordinates: LonLat[] };
  check: {
    legs: { status: string; part: string; xteLimit?: number }[];
    parts: { part: string; xteLimit?: number; legs: [number, number] }[];
  };
}

async function planned(chart: Chart, over: Partial<PlanInput> = {}, opts = DEFAULT_PLAN) {
  const api = syntheticApi(chart);
  const r = await plan(
    api,
    { from: FROM, to: TO, departure: NOW, speed: 3, xteLimit: 30, ...over },
    NEVER,
    NOW,
    opts
  );
  return { r, body: r.body as Body, api };
}

/** Whether every leg passes the chart's own check at its part's corridor, the buffer 10 m. */
function eachAtItsCorridor(chart: Chart, body: Body, xte = 30): boolean {
  const c = body.route.coordinates;
  return body.check.legs.every(
    (l, i) =>
      legStatus(chart, c[i] as LonLat, c[i + 1] as LonLat, (l.xteLimit ?? xte) + 10) === "ok"
  );
}

/** Whether the route crosses x = 3000 within `d` metres of y = 0: through the sound. */
function throughSound(route: LonLat[], d = 30): boolean {
  return route.slice(1).some((b, i) => {
    const [ax, ay] = xy(route[i] as LonLat);
    const [bx, by] = xy(b);
    if ((ax - 3000) * (bx - 3000) > 0) {
      return false;
    }
    const t = ax === bx ? 0 : (3000 - ax) / (bx - ax);
    return Math.abs(ay + t * (by - ay)) < d;
  });
}

describe("narrows", () => {
  test("a sound narrower than the corridor is planned through at the harbour corridor", async () => {
    const chart = sound(1500);
    const { r, body, api } = await planned(chart);
    expect(r.status).toBe(200);
    expect(throughSound(body.route.coordinates)).toBe(true);
    expect(body.length).toBeLessThan(6300);
    // The sound's legs in a narrows part at xte 0, open water at the request's 30 m.
    const parts = body.check.parts.map((p) => [p.part, p.xteLimit]);
    expect(parts).toContainEqual(["narrows", 0]);
    expect(parts.every(([p, x]) => (p === "narrows" ? x === 0 : x === 30))).toBe(true);
    expect(eachAtItsCorridor(chart, body)).toBe(true);
    expect(body.check.legs.every((l) => l.status === "ok")).toBe(true);
    // The search at the harbour corridor, then its legs checked at the request's corridor.
    expect(api.sessions.map((s) => s.xteLimit)).toEqual([0, 30]);
    // The request's corridor does not pass the sound.
    expect(legStatus(chart, at(2900, 0), at(3100, 0), 40)).toBe("fail");
  });

  test("with narrows off the route keeps to the request's corridor, the long way round", async () => {
    const chart = sound(1500);
    const { r, body } = await planned(chart, { narrows: false });
    expect(r.status).toBe(200);
    expect(throughSound(body.route.coordinates)).toBe(false);
    expect(body.length).toBeGreaterThan(8000);
    expect(body.check.parts.map((p) => p.part)).toEqual(["route"]);
    expect(eachAtItsCorridor(chart, body)).toBe(true);
  });

  test("narrow water's cost decides between the sound and the way round", async () => {
    // Small islands: round them is about 3 % longer than through the sound.
    const chart = sound(300);
    const dear = await planned(chart, {}, { ...DEFAULT_PLAN, narrowWeight: 10 });
    expect(dear.r.status).toBe(200);
    expect(throughSound(dear.body.route.coordinates)).toBe(false);
    expect(dear.body.check.parts.every((p) => p.part === "route" && p.xteLimit === 30)).toBe(true);
    const cheap = await planned(chart, {}, { ...DEFAULT_PLAN, narrowWeight: 0.01 });
    expect(cheap.r.status).toBe(200);
    expect(throughSound(cheap.body.route.coordinates)).toBe(true);
    expect(cheap.body.length).toBeLessThan(dear.body.length);
    expect(eachAtItsCorridor(chart, cheap.body)).toBe(true);
  });

  test("narrow water on a charted line costs nothing more: the fairway through the sound", async () => {
    const line = {
      class: "NAVLINE",
      points: [
        [0, 0],
        [6000, 0]
      ] as [number, number][]
    };
    const chart: Chart = { ...sound(300), lines: [line] };
    const opts = { ...DEFAULT_PLAN, narrowWeight: 10 };
    const { r, body } = await planned(chart, {}, opts);
    expect(r.status).toBe(200);
    expect(throughSound(body.route.coordinates)).toBe(true);
    expect(body.check.parts.map((p) => [p.part, p.xteLimit])).toContainEqual(["narrows", 0]);
    expect(eachAtItsCorridor(chart, body)).toBe(true);
    // A line laid out for less than the draft is no fairway for this boat.
    const shallow: Chart = { ...sound(300), lines: [{ ...line, designDraft: 1 }] };
    const deep = await planned(shallow, { draft: 1.8 }, opts);
    expect(throughSound(deep.body.route.coordinates)).toBe(false);
  });

  test("open water: the direct line, as without narrows", async () => {
    const { r, body, api } = await planned({ obstacles: [{ x: 3000, y: 2000, r: 400 }] });
    expect(r.status).toBe(200);
    expect(body.route.coordinates).toEqual([FROM, TO]);
    expect(body.check.parts.map((p) => [p.part, p.xteLimit])).toEqual([["route", 30]]);
    // The request's corridor passes the narrow search's one leg: no wide search.
    expect(api.sessions.map((s) => s.xteLimit)).toEqual([0, 30]);
  });

  test("round an island every leg keeps the request's corridor, pulled straight at it", async () => {
    const chart = { obstacles: [{ x: 3000, y: 0, r: 400 }] };
    const { r, body, api } = await planned(chart);
    expect(r.status).toBe(200);
    expect(body.check.parts.map((p) => [p.part, p.xteLimit])).toEqual([["route", 30]]);
    // The search, its legs checked, then its route part pulled straight at the request's corridor.
    expect(api.sessions.map((s) => s.xteLimit)).toEqual([0, 30, 30]);
    expect(eachAtItsCorridor(chart, body)).toBe(true);
    // The same at the request's corridor alone, within a few metres.
    const wide = await planned(chart, { narrows: false });
    expect(Math.abs(body.length - wide.body.length)).toBeLessThan(0.02 * wide.body.length);
  });

  test("a risk weight, or a corridor no wider than the harbour's, plans without narrows", async () => {
    const chart = sound(1500);
    const weighted = await planned(chart, { riskWeight: 2 });
    expect(weighted.r.status).toBe(200);
    expect(throughSound(weighted.body.route.coordinates)).toBe(false);
    expect(weighted.api.sessions.every((s) => s.xteLimit === 30)).toBe(true);
    const narrow = await planned(chart, { xteLimit: 0 });
    expect(narrow.r.status).toBe(200);
    expect(narrow.body.check.parts.map((p) => [p.part, p.xteLimit])).toEqual([["route", 0]]);
    expect(narrow.api.sessions.every((s) => s.xteLimit === 0)).toBe(true);
  });

  test("with no way at the harbour corridor, no search runs at the request's: it has none either", async () => {
    const closed: Chart = {
      obstacles: [
        { x: 3000, y: 0, r: 2500 },
        { x: 3000, y: 9000, r: 6600 },
        { x: 3000, y: -9000, r: 6600 }
      ]
    };
    const roomy = { ...DEFAULT_PLAN, maxWork: 20_000_000 };
    const { r, body, api } = await planned(closed, {}, roomy);
    expect(r.status).toBe(422);
    expect(body.reason).toMatch(/no route the check passes connects the points/);
    // The narrow search, then the direct line at the request's corridor for the reply.
    expect(api.sessions.map((s) => s.xteLimit)).toEqual([0, 30]);
    // Asked with a fallback, the narrow search crosses what the fallback may, never land.
    const fallback = await planned(closed, { fallback: true }, roomy);
    expect(fallback.r.status).toBe(422);
    expect(fallback.api.sessions.map((s) => s.xteLimit)).toEqual([0, 30]);
  });

  test("a narrow search that reaches the work limit refuses the plan, never offers a route", async () => {
    const chart = sound(1500);
    const full = await planned(chart);
    const used = (full.body as unknown as { work: number }).work;
    for (const share of [0.3, 0.6, 0.9]) {
      const tight = await planned(
        chart,
        {},
        { ...DEFAULT_PLAN, maxWork: Math.floor(used * share) }
      );
      const reason = (tight.body as { reason?: string }).reason ?? "";
      expect(tight.r.status === 200 || reason.includes(WORK_LIMIT)).toBe(true);
      if (tight.r.status === 200) {
        expect(eachAtItsCorridor(chart, tight.body)).toBe(true);
      }
    }
  });

  test("a sound the tide opens is timed by the gate, its legs still at the harbour corridor", async () => {
    const HOUR = 3_600_000;
    // The sound the only way through, its bar needing 1 m of water: below it for six hours.
    const chart: Chart = {
      obstacles: [
        ...sound(1500).obstacles,
        { x: 3000, y: 9000, r: 6600 },
        { x: 3000, y: -9000, r: 6600 }
      ],
      tidal: [{ x: 3000, y: 0, r: 40, needs: 1 }],
      tide: (t) => 1 - 1.2 * Math.sin((2 * Math.PI * (t - NOW)) / (12 * HOUR))
    };
    const opts = { ...DEFAULT_PLAN, maxWork: 6_000_000 };
    const { r, body } = await planned(chart, { latestDeparture: NOW + 12 * HOUR }, opts);
    expect(r.status).toBe(200);
    expect(throughSound(body.route.coordinates)).toBe(true);
    expect(body.check.parts.map((p) => [p.part, p.xteLimit])).toContainEqual(["narrows", 0]);
    const gate = (body as unknown as { gate?: { departure?: string } }).gate;
    expect(Date.parse(gate?.departure ?? "")).toBeGreaterThan(NOW + 5 * HOUR);
  });

  test("legs group into parts by the corridor that passes them", () => {
    const p = (x: number): LonLat => [x, 0];
    const route = [p(0), p(1), p(2), p(3), p(4), p(5)];
    expect(narrowParts(route, [true, false, false, true, true], 30, 0)).toEqual([
      { kind: "route", coordinates: [p(0), p(1)], xteLimit: 30 },
      { kind: "narrows", coordinates: [p(1), p(2), p(3)], xteLimit: 0 },
      { kind: "route", coordinates: [p(3), p(4), p(5)], xteLimit: 30 }
    ]);
    // The request's default corridor stays unnamed, as for a route part without narrows.
    expect(narrowParts(route.slice(0, 2), [false], undefined, 0)).toEqual([
      { kind: "narrows", coordinates: [p(0), p(1)], xteLimit: 0 }
    ]);
  });

  test("narrows is true or false in a request", () => {
    const base = { from: [22, 60], to: [22.1, 60.1] };
    expect(parsePlanRequest({ ...base, narrows: "yes" }, NOW).ok).toBe(false);
    const off = parsePlanRequest({ ...base, narrows: false }, NOW);
    expect(off.ok && off.value.narrows).toBe(false);
  });
});

const circle = fc.record({
  x: fc.integer({ min: 500, max: 5500 }),
  y: fc.integer({ min: -2500, max: 2500 }),
  r: fc.integer({ min: 50, max: 700 })
});

/** Circles that leave start and goal in open water; gaps between them make narrows. */
const charts = fc.array(circle, { minLength: 2, maxLength: 10 }).map((cs) => ({
  obstacles: cs.filter(
    (k: Circle) => Math.hypot(k.x, k.y) > k.r + 600 && Math.hypot(k.x - 6000, k.y) > k.r + 600
  )
}));

const lengthOf = (c: LonLat[]): number =>
  c.slice(1).reduce((s, p, i) => s + haversine(c[i] as LonLat, p), 0);

describe("narrows properties", () => {
  test("every leg of an offered route passes the chart's check at its own part's corridor", async () => {
    await fc.assert(
      fc.asyncProperty(charts, async (chart) => {
        const { r, body } = await planned(chart);
        return r.status !== 200 || eachAtItsCorridor(chart, body);
      }),
      { numRuns: 25 }
    );
  });

  test("a deeper draft's route passes the shallower chart, which is refused only for work", async () => {
    await fc.assert(
      fc.asyncProperty(charts, fc.integer({ min: 0, max: 150 }), async (chart, grow) => {
        const deep: Chart = { obstacles: chart.obstacles.map((c) => ({ ...c, r: c.r + grow })) };
        const d = await planned(deep);
        if (d.r.status !== 200) {
          return true;
        }
        const shallow = await planned(chart);
        const reason = (shallow.body as { reason?: string }).reason ?? "";
        return (
          eachAtItsCorridor(chart, d.body) &&
          (shallow.r.status === 200 || reason.includes(WORK_LIMIT)) &&
          lengthOf(d.body.route.coordinates) > 0
        );
      }),
      { numRuns: 25 }
    );
  });
});
