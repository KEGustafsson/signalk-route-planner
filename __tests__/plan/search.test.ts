import type { LonLat } from "../../src/foundation/geo";
import { EARTH_RADIUS, frameAt, grownBoxKm2, haversine } from "../../src/foundation/geo";
import { DEFAULT_PLAN } from "../../src/plan/options";
import type { SearchOutcome } from "../../src/plan/search";
import { searchRoute, shapeFor } from "../../src/plan/search";
import type { Session } from "../../src/oracle/contract";
import { QuadTree } from "../../src/search/quadtree";
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

  test("a region across the 180° meridian or over a pole is refused", () => {
    expect(shapeFor([179.99, 10], [-179.99, 10], 40, DEFAULT_PLAN)).toMatch(/180° meridian/);
    expect(shapeFor([0, 89.95], [180, 89.95], 40, DEFAULT_PLAN)).toMatch(/pole/);
  });

  test("far from the frame's origin at high latitude, every box stays inside the API's bound", () => {
    // Underkeel's planning API: the box grown by r, its width at the mean latitude.
    const k = Math.PI / 180;
    const underkeelKm2 = (sw: LonLat, ne: LonLat, r: number) => {
      const dLat = r / (EARTH_RADIUS * k);
      const [s, n] = [sw[1] - dLat, ne[1] + dLat];
      const dLon = r / (EARTH_RADIUS * k * Math.cos(Math.max(Math.abs(s), Math.abs(n)) * k));
      const width = (ne[0] - sw[0] + 2 * dLon) * k * EARTH_RADIUS * Math.cos(((s + n) / 2) * k);
      return (width * (n - s) * k * EARTH_RADIUS) / 1e6;
    };
    const r = 816;
    const shape = shapeFor([0, 84.45], [0, 84.95], r, DEFAULT_PLAN);
    if (typeof shape === "string") {
      throw new Error(shape);
    }
    const areas: number[] = [];
    const session = {
      halfWidth: r,
      box: (sw: LonLat, ne: LonLat) => {
        areas.push(underkeelKm2(sw, ne, r));
        return { status: "ok", risk: 0, flags: [] };
      }
    } as unknown as Session;
    const tree = new QuadTree(shape, session);
    // The south-west corner, farthest from the origin's latitude on the equator side.
    tree.leaves((n) => n.x === 0 && n.y === 0);
    expect(areas.length).toBeGreaterThan(0);
    expect(Math.max(...areas)).toBeLessThanOrEqual(25);
    expect(grownBoxKm2([0, 0], [0.01, 0.01], 0)).toBeCloseTo(
      (0.01 * k * EARTH_RADIUS) ** 2 / 1e6,
      3
    );
  });

  test("a start whose own square is blocked joins only squares whose centres are within reach", async () => {
    const api = syntheticApi({ obstacles: [] });
    const from = at(0, 0);
    const to = at(5000, 0);
    const opts = { ...DEFAULT_PLAN, accessMetres: 30 };
    const shape = shapeFor(from, to, 40, opts);
    if (typeof shape === "string") {
      throw new Error(shape);
    }
    const frame = frameAt(shape.frame.origin);
    const [fx, fy] = frame.toXY(from);
    // Every square within 25 m of the start fails, so the nearest free centres are over 30 m off.
    const inside = (sw: LonLat, ne: LonLat) => {
      const [x0, y0] = frame.toXY(sw);
      const [x1, y1] = frame.toXY(ne);
      return Math.hypot(Math.max(x0 - fx, 0, fx - x1), Math.max(y0 - fy, 0, fy - y1)) < 25;
    };
    const r = await api.session({ departure: 0, until: 1, speed: 3 }, NEVER, (s) => {
      s.box = (sw, ne) =>
        inside(sw, ne)
          ? { status: "fail", risk: 0.9, flags: [] }
          : { status: "ok", risk: 0, flags: [] };
      s.segment = (a, b) =>
        a === from && b === to
          ? { status: "fail", risk: 0.9, flags: [] }
          : { status: "ok", risk: 0, flags: [] };
      return searchRoute(s, from, to, opts);
    });
    if (!r.ok) {
      throw new Error(r.error);
    }
    const o = r.value;
    expect(!o.ok || haversine(from, o.coordinates[1] as LonLat) <= 30 + 1e-6).toBe(true);
  });

  test("a corridor too wide to plan in is refused", () => {
    expect(shapeFor(at(0, 0), at(1000, 0), 2600, DEFAULT_PLAN)).toMatch(/too wide/);
  });
});

describe("long legs", () => {
  test("a leg whose corridor is over 24 km² is never sent to the planning API", async () => {
    // 40 km apart at ±400 m: (40 km + 800 m) × 800 m = 32.6 km² for the direct line.
    const api = syntheticApi({ obstacles: [{ x: 20000, y: 0, r: 600 }], halfWidth: 400 });
    const longest: number[] = [];
    const r = await api.session({ departure: 0, until: 1, speed: 3 }, NEVER, (s) => {
      const segment = s.segment.bind(s);
      s.segment = (a, b) => {
        longest.push(haversine(a, b));
        return segment(a, b);
      };
      return searchRoute(s, at(0, 0), at(40000, 0), DEFAULT_PLAN);
    });
    expect(r.ok && r.value.direct).toEqual({
      status: "unverified",
      risk: 0,
      flags: ["TOO_LONG_FOR_ONE_LEG"]
    });
    expect(Math.max(...longest)).toBeLessThanOrEqual(24e6 / 800 - 800);
    expect(r.ok && r.value.ok).toBe(true);
  });
});
