import type { LonLat } from "../../src/foundation/geo";
import { haversine } from "../../src/foundation/geo";
import { DEFAULT_PLAN } from "../../src/plan/options";
import type { SearchOutcome } from "../../src/plan/search";
import { searchRoute, shapeFor } from "../../src/plan/search";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, legStatus, syntheticApi } from "../helpers/synthetic-oracle";

/** The static search (plan §4.1) over the synthetic chart. */

const NEVER = new AbortController().signal;

async function search(chart: Chart, from: LonLat, to: LonLat, opts = DEFAULT_PLAN) {
  const api = syntheticApi(chart);
  const r = await api.session({ departure: 0, until: 1, speed: 3 }, NEVER, (s) =>
    searchRoute(s, from, to, opts)
  );
  if (!r.ok) {
    throw new Error(r.error);
  }
  return { outcome: r.value, api };
}

const length = (c: LonLat[]) => c.slice(1).reduce((s, p, i) => s + haversine(c[i] as LonLat, p), 0);

/** Every leg of an ok outcome passes the chart's own leg check. */
function legsPass(chart: Chart, o: SearchOutcome): boolean {
  return (
    o.ok &&
    o.coordinates
      .slice(1)
      .every((b, i) => legStatus(chart, o.coordinates[i] as LonLat, b, 40) === "ok")
  );
}

describe("static search", () => {
  test("open water: the direct line, and no quadtree", async () => {
    const chart = { obstacles: [] };
    const { outcome, api } = await search(chart, at(0, 0), at(5000, 0));
    expect(outcome.ok && outcome.coordinates).toEqual([at(0, 0), at(5000, 0)]);
    expect(api.boxes).toBe(0);
  });

  test("an island on the line: a detour that clears it, not far longer than going round it", async () => {
    const chart = { obstacles: [{ x: 2500, y: 0, r: 600 }] };
    const { outcome } = await search(chart, at(0, 0), at(5000, 0));
    expect(outcome.direct.status).toBe("fail");
    expect(legsPass(chart, outcome)).toBe(true);
    // Round the island with the 40 m corridor: about 5.2 km; the grid's turns add a little.
    const l = outcome.ok ? length(outcome.coordinates) : Infinity;
    expect(l).toBeGreaterThan(5000);
    expect(l).toBeLessThan(5000 * 1.25);
    expect(outcome.ok && outcome.coordinates.length).toBeLessThanOrEqual(6);
  });

  test("a wall with one gap: the route goes through the gap", async () => {
    // A wall across x = 2500 from y = -3000 to 3000, of circles, with a gap at y = 1500.
    const wall = Array.from({ length: 31 }, (_, i) => ({
      x: 2500,
      y: -3000 + i * 200,
      r: 110
    })).filter((c) => Math.abs(c.y - 1500) > 300);
    const chart = { obstacles: wall };
    const { outcome } = await search(chart, at(0, 0), at(5000, 0));
    expect(legsPass(chart, outcome)).toBe(true);
    const ys = outcome.ok ? outcome.coordinates.map((p) => p[1]) : [];
    expect(Math.max(...ys)).toBeGreaterThan(at(0, 1000)[1]);
  });

  test("closed off: refused with the reason, never a route", async () => {
    const ring = Array.from({ length: 48 }, (_, i) => {
      const t = (i / 48) * 2 * Math.PI;
      return { x: 5000 + 1500 * Math.cos(t), y: 1500 * Math.sin(t), r: 150 };
    });
    const { outcome } = await search({ obstacles: ring }, at(0, 0), at(5000, 0));
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toMatch(
      /no water the route check passes within 500 m of the destination|land, shoals/
    );
  });

  test("only unverified water connects: the reason says so", async () => {
    // A wall across the whole region; its one gap is water the check cannot verify.
    const wall = Array.from({ length: 61 }, (_, i) => ({
      x: 2500,
      y: -6000 + i * 200,
      r: 110
    })).filter((c) => Math.abs(c.y) > 300);
    const chart = { obstacles: wall, unverified: [{ x: 2500, y: 0, r: 300 }] };
    const { outcome } = await search(chart, at(0, 0), at(5000, 0));
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toMatch(/cannot verify/);
    expect(!outcome.ok && outcome.unverified).toBeGreaterThan(0);
  });

  test("a start inside land with its corridor is refused, naming the start", async () => {
    const chart = {
      obstacles: [
        { x: -200, y: 0, r: 230 },
        { x: 2500, y: 0, r: 500 }
      ]
    };
    const { outcome } = await search(chart, at(0, 0), at(5000, 0));
    // The start itself is 30 m inside the land circle with its corridor: the first leg fails...
    expect(legStatus(chart, at(0, 0), at(1, 0), 40)).toBe("fail");
    // ...so there is no route from it, and the reason names the start.
    expect(!outcome.ok && outcome.reason).toMatch(/of the start/);
  });

  test("a search over its work limit is refused, not returned in part", async () => {
    const chart = { obstacles: [{ x: 2500, y: 0, r: 600 }] };
    const { outcome } = await search(chart, at(0, 0), at(5000, 0), {
      ...DEFAULT_PLAN,
      maxWork: 2000
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toMatch(/work limit/);
  });
});

describe("tree shape", () => {
  test("squares are at least half the corridor half-width, and boxes stay under 25 km² with it", () => {
    const s = shapeFor(at(0, 0), at(40000, 0), 100, DEFAULT_PLAN);
    if (typeof s === "string") {
      throw new Error(s);
    }
    expect(s.unit).toBeGreaterThanOrEqual(50);
    expect(s.side).toBeLessThanOrEqual(DEFAULT_PLAN.maxSideUnits);
    expect((s.maxLeaf * s.unit + 200) ** 2).toBeLessThanOrEqual(25e6);
    // The region holds both ends with margin.
    expect(s.side * s.unit).toBeGreaterThanOrEqual(80000);
  });

  test("a corridor too wide to plan in is refused", () => {
    expect(shapeFor(at(0, 0), at(1000, 0), 2600, DEFAULT_PLAN)).toMatch(/too wide/);
  });
});
