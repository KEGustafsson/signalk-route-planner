import type { LonLat } from "../../src/foundation/geo";
import { haversine } from "../../src/foundation/geo";
import type {
  Bbox,
  PlanningApiV1,
  Prepared,
  PrepareResult,
  Survey
} from "../../src/oracle/contract";
import { canSurvey } from "../../src/oracle/contract";
import {
  boxOf,
  coarseRoute,
  CORRIDOR_HALF,
  CORRIDOR_WIDTHS,
  corridorsFor,
  corridorParts,
  surveyRegion
} from "../../src/plan/corridor";
import { BUILDING, inCorridor, Preparer, searchRegion, tripRegion } from "../../src/plan/prepare";
import { syntheticApi } from "../helpers/synthetic-oracle";

/** A corridor on the depth survey, for a trip too long for any planning box (plan §4.2). */

const CELL = 100;
const M_PER_DEG = 111_195;

/** A survey of `cols` × `rows` cells from [22, 60], `depth(c, r)` in each. */
function grid(cols: number, rows: number, depth: (c: number, r: number) => number): Survey {
  const dLat = CELL / M_PER_DEG;
  const dLon = CELL / (M_PER_DEG * Math.cos(((60 + (60 + rows * dLat)) / 2) * (Math.PI / 180)));
  const d = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      d[r * cols + c] = depth(c, r);
    }
  }
  return {
    bbox: [22, 60, 22 + cols * dLon, 60 + rows * dLat],
    cols,
    rows,
    cellMetres: CELL,
    depth: d
  };
}

/** The centre of cell (c, r). */
function centre(g: Survey, c: number, r: number): LonLat {
  const dLon = (g.bbox[2] - g.bbox[0]) / g.cols;
  const dLat = (g.bbox[3] - g.bbox[1]) / g.rows;
  return [g.bbox[0] + (c + 0.5) * dLon, g.bbox[1] + (r + 0.5) * dLat];
}

const inside = (b: Bbox, p: LonLat): boolean =>
  p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

describe("survey region", () => {
  test("the trip's box grown by a quarter of the trip, within the reach limits", () => {
    const from: LonLat = [22, 60];
    const to: LonLat = [22, 60.8];
    const r = surveyRegion(from, to);
    // 89 km: a quarter is 22 km, held to 15 km.
    expect(haversine([22, 60], [22, r[1]])).toBeCloseTo(15_000, -2);
    const short = surveyRegion(from, [22, 60.02]);
    expect(haversine([22, 60], [22, short[1]])).toBeCloseTo(3000, -2);
  });
});

describe("coarse route", () => {
  // Water 5 m deep but for an island across the middle, open only at its north end.
  const g = grid(200, 100, (c, r) => (c >= 90 && c <= 110 && r < 85 ? Number.NaN : 5));

  test("goes round what does not take the draft", () => {
    const from = centre(g, 20, 20);
    const to = centre(g, 180, 20);
    const path = coarseRoute(g, from, to, 2);
    expect(path).toBeDefined();
    const rows = (path ?? []).map((i) => Math.floor(i / g.cols));
    expect(Math.max(...rows)).toBeGreaterThanOrEqual(85);
    // Never through a cell that does not take the draft.
    expect((path ?? []).every((i) => (g.depth[i] as number) >= 2)).toBe(true);
  });

  test("keeps to cells deep enough all over before a shorter way through ones that may not be", () => {
    // A wide band of cells whose deepest takes the draft and whose shallowest does not (shoals
    // the cells blur), across the way, and sure water round its north end.
    const base = grid(200, 100, () => 5);
    const shallowest = new Float32Array(base.depth.length).fill(5);
    for (let r = 0; r < 40; r++) {
      for (let c = 80; c <= 130; c++) {
        shallowest[r * 200 + c] = 0.5;
      }
    }
    const from = centre(base, 70, 20);
    const to = centre(base, 140, 20);
    const rows = (p: number[] | undefined) => (p ?? []).map((i) => Math.floor(i / 200));
    expect(
      Math.max(...rows(coarseRoute({ ...base, shallowest }, from, to, 2)))
    ).toBeGreaterThanOrEqual(40);
    // Without the shallowest, straight across.
    expect(Math.max(...rows(coarseRoute(base, from, to, 2)))).toBeLessThan(25);
  });

  test("none when the draft is deeper than the survey joins the ends by", () => {
    expect(coarseRoute(g, centre(g, 20, 20), centre(g, 180, 20), 6)).toBeUndefined();
    const closed = grid(200, 100, (c) => (c === 100 ? Number.NaN : 5));
    expect(coarseRoute(closed, centre(closed, 20, 20), centre(closed, 180, 20), 2)).toBeUndefined();
  });

  test("an end on land is joined to the nearest cell that takes the draft", () => {
    const land = grid(100, 50, (c) => (c < 10 ? Number.NaN : 5));
    const path = coarseRoute(land, centre(land, 5, 25), centre(land, 90, 25), 2);
    expect(path?.[0]).toBe(25 * 100 + 10);
  });
});

describe("corridor", () => {
  const g = grid(400, 300, () => 8);
  const from = centre(g, 20, 20);
  const to = centre(g, 380, 280);

  test("bands holding the coarse route with its reach each side, and both ends' harbours", () => {
    const parts = corridorsFor(g, from, to, 2)?.[0] ?? [];
    expect(parts.length).toBeGreaterThan(10);
    const path = coarseRoute(g, from, to, 2) ?? [];
    for (const i of path) {
      const p = centre(g, i % g.cols, Math.floor(i / g.cols));
      expect(parts.some((b) => inside(b, p))).toBe(true);
    }
    // 3 km around each end, for the harbour stage.
    expect(parts.some((b) => inside(b, centre(g, 20 + 30, 20 - 15)))).toBe(true);
    // The bands do not overlap, and their area is far less than their box's.
    const area = (b: Bbox) => (b[2] - b[0]) * (b[3] - b[1]);
    const sum = parts.reduce((a, b) => a + area(b), 0);
    expect(sum).toBeLessThan(area(boxOf(parts)) * 0.4);
    for (const [i, a] of parts.entries()) {
      for (const b of parts.slice(i + 1)) {
        const overlap = a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
        expect(overlap).toBe(false);
      }
    }
    expect(CORRIDOR_HALF).toBe(1500);
  });

  test("the reach each side: 1 km off the route is in, 3 km off is not", () => {
    const a = centre(g, 20, 150);
    const b = centre(g, 380, 150);
    const parts = corridorsFor(g, a, b, 2)?.[0] ?? [];
    const has = (p: LonLat) => parts.some((x) => inside(x, p));
    expect(has(centre(g, 200, 160))).toBe(true);
    expect(has(centre(g, 200, 140))).toBe(true);
    expect(has(centre(g, 200, 180))).toBe(false);
    expect(has(centre(g, 200, 120))).toBe(false);
  });

  test("at most 400 boxes: bands grow taller for a winding corridor", () => {
    // A path zig-zagging down every other column would cut thousands of runs.
    const path: number[] = [];
    for (let c = 0; c < 400; c += 40) {
      for (let r = 0; r < 300; r++) {
        path.push(r * 400 + c);
      }
    }
    expect(corridorParts(g, path, from, to).length).toBeLessThanOrEqual(400);
  });
});

/** A provider whose prepare refuses regions over `maxKm2`, with a survey of `g`. */
function provider(g: Survey | undefined, maxKm2: number) {
  const asked: { region: Bbox; corridor?: readonly Bbox[] }[] = [];
  const surveys: Bbox[] = [];
  const inner = syntheticApi({ obstacles: [] });
  const prepared: Prepared = {
    coverage: undefined,
    session: (p, s, job) => inner.session(p, s, job),
    routeCheck: (b, s) => inner.routeCheck(b, s),
    release: () => undefined
  };
  const km2 = (b: Bbox) =>
    (((b[2] - b[0]) * Math.cos((b[1] * Math.PI) / 180) * M_PER_DEG) / 1000) *
    (((b[3] - b[1]) * M_PER_DEG) / 1000);
  const api: PlanningApiV1 = {
    ...inner,
    features: g ? ["prepare", "corridor", "survey"] : ["prepare"],
    prepare: (region, _signal, corridor) => {
      asked.push({ region, ...(corridor && { corridor }) });
      const area = corridor ? corridor.reduce((a, b) => a + km2(b), 0) : km2(region);
      return Promise.resolve<PrepareResult>(
        area > maxKm2
          ? { ok: false, status: 413, error: `${Math.round(area)} km²` }
          : { ok: true, value: prepared }
      );
    },
    ...(g && {
      survey: (region: Bbox) => {
        surveys.push(region);
        return Promise.resolve({ ok: true as const, value: g });
      }
    })
  };
  return { api, asked, surveys };
}

describe("Preparer with a survey", () => {
  const g = grid(600, 500, () => 8);
  const from = centre(g, 20, 20);
  const to = centre(g, 560, 460);

  test("the whole region, the least, then a corridor of the trip on the survey", async () => {
    const p = provider(g, 1000);
    expect(canSurvey(p.api)).toBe(true);
    const r = await new Preparer(1000).forTrip(p.api, from, to, new AbortController().signal, 1.8);
    expect("version" in r).toBe(true);
    expect(p.asked.map((a) => a.region)).toEqual([
      searchRegion(from, to),
      tripRegion(from, to),
      boxOf(p.asked[2]?.corridor ?? [])
    ]);
    expect(p.surveys).toEqual([surveyRegion(from, to)]);
    expect(p.asked[2]?.corridor?.length).toBeGreaterThan(10);
  });

  test("a corridor's index says its boxes to the search's sessions", async () => {
    const p = provider(g, 1000);
    const r = await new Preparer(1000).forTrip(p.api, from, to, new AbortController().signal);
    if (!("version" in r)) {
      throw new Error("no index");
    }
    const parts = p.asked[2]?.corridor;
    const s = await r.session(
      { departure: 0, until: 1, speed: 3 },
      new AbortController().signal,
      (x) => Promise.resolve(x.within)
    );
    expect(s).toEqual({ ok: true, value: parts });
    expect(inCorridor(r)).toBe(true);
    // A region's index says none.
    const q = provider(g, 1e9);
    const whole = await new Preparer(1000).forTrip(q.api, from, to, new AbortController().signal);
    if (!("version" in whole)) {
      throw new Error("no index");
    }
    const t = await whole.session(
      { departure: 0, until: 1, speed: 3 },
      new AbortController().signal,
      (x) => Promise.resolve(x.within)
    );
    expect(t).toEqual({ ok: true, value: undefined });
    expect(inCorridor(whole)).toBe(false);
  });

  test("narrower corridors in turn while the widest is too large to build", async () => {
    const p = provider(g, 1000);
    const widest = p.api;
    const r0 = await new Preparer(1000).forTrip(widest, from, to, new AbortController().signal);
    expect("version" in r0).toBe(true);
    const area = (parts: readonly Bbox[]) =>
      parts.reduce(
        (a, b) =>
          a +
          (b[2] - b[0]) *
            Math.cos((b[1] * Math.PI) / 180) *
            (b[3] - b[1]) *
            (M_PER_DEG / 1000) ** 2,
        0
      );
    const wide = area(p.asked[2]?.corridor ?? []);
    // A cap between the narrowest corridor's area and the widest's: the narrower ones are asked.
    const q = provider(g, wide * 0.6);
    const r = await new Preparer(1000).forTrip(q.api, from, to, new AbortController().signal);
    const corridors = q.asked.filter((a) => a.corridor).map((a) => area(a.corridor ?? []));
    expect(corridors.length).toBeGreaterThan(1);
    expect(corridors.length).toBeLessThanOrEqual(CORRIDOR_WIDTHS.length);
    for (let i = 1; i < corridors.length; i++) {
      expect(corridors[i]).toBeLessThan(corridors[i - 1] as number);
    }
    expect("version" in r).toBe(true);
  });

  test("without a survey, the least region's refusal is the reply", async () => {
    const p = provider(undefined, 200);
    const r = await new Preparer(1000).forTrip(p.api, from, to, new AbortController().signal);
    expect(r).toMatchObject({ status: 413 });
    expect(p.asked).toHaveLength(2);
  });

  test("a survey that joins the ends by none: the least region's refusal is the reply", async () => {
    const shut = grid(600, 500, (c) => (c === 300 ? Number.NaN : 8));
    const p = provider(shut, 200);
    const r = await new Preparer(1000).forTrip(p.api, from, to, new AbortController().signal);
    expect(r).toMatchObject({ status: 413 });
    expect(p.asked).toHaveLength(2);
  });

  test("a corridor build serves its own trip alone", async () => {
    let settle: (r: PrepareResult) => void = () => undefined;
    const p = provider(g, 200);
    const prepare = p.api.prepare;
    p.api.prepare = (region, signal, corridor) =>
      corridor
        ? new Promise((resolve) => {
            p.asked.push({ region, corridor });
            settle = resolve;
          })
        : (prepare as NonNullable<typeof prepare>)(region, signal);
    const prep = new Preparer(5);
    const stop = new AbortController().signal;
    expect(await prep.forTrip(p.api, from, to, stop)).toBe(BUILDING);
    const corridors = () => p.asked.filter((a) => a.corridor).length;
    expect(corridors()).toBe(1);
    // The same trip again: the same build.
    expect(await prep.forTrip(p.api, from, to, stop)).toBe(BUILDING);
    expect(corridors()).toBe(1);
    // Another trip inside the corridor's box: its own build.
    void prep.forTrip(p.api, centre(g, 100, 100), centre(g, 500, 400), stop);
    await new Promise((r) => setImmediate(r));
    expect(corridors()).toBe(2);
    // The same trip at another draft: its own corridor.
    void prep.forTrip(p.api, from, to, stop, 3.5);
    await new Promise((r) => setImmediate(r));
    expect(corridors()).toBe(3);
    settle({ ok: false, status: 503, error: "done" });
  });
});
