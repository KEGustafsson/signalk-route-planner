import fc from "fast-check";
import type { LonLat } from "../../src/foundation/geo";
import { plan } from "../../src/plan/plan";
import { berthable, crossable } from "../../src/search/fallback";
import type { Chart, Circle } from "../helpers/synthetic-oracle";
import { at, legVerdict, syntheticApi } from "../helpers/synthetic-oracle";

/**
 * The fallback (plan §4.1 step 8): when no route passes, the lowest risk-weighted route
 * through charted water, never over land, with every leg's status the route
 * check's, so the legs over shallows come back `fail`, marked.
 */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");

/** A land wall across x = 2500 with one gap at y = 0 of the given kind. */
function wall(gap?: "shallows" | "land"): Chart {
  const land: Circle[] = Array.from({ length: 61 }, (_, i) => ({
    x: 2500,
    y: -6000 + i * 200,
    r: 110
  })).filter((c) => gap === "land" || Math.abs(c.y) > 300);
  return gap === "shallows"
    ? { obstacles: land, shallows: [{ x: 2500, y: 0, r: 300 }] }
    : { obstacles: land };
}

async function run(chart: Chart, fallback?: boolean) {
  return plan(
    syntheticApi(chart),
    // The fallback at the request's corridor alone: `narrows.test.ts` covers it with narrows.
    { from: at(0, 0), to: at(5000, 0), departure: NOW, speed: 3, fallback, narrows: false },
    NEVER,
    NOW
  );
}

interface Body {
  status: string;
  fallback?: string;
  route: { coordinates: LonLat[] };
  check: { legs: { status: string }[] };
}

describe("fallback", () => {
  test("off: the shallow bar closes the way and the plan is refused", async () => {
    expect((await run(wall("shallows"))).status).toBe(422);
  });

  test("on: the route crosses the bar, only the legs over it fail, and it says why", async () => {
    const chart = wall("shallows");
    const r = await run(chart, true);
    expect(r.status).toBe(200);
    const b = r.body as Body;
    expect(b.status).toBe("fail");
    expect(b.fallback).toMatch(/no route the check passes connects the points/);
    const statuses = b.check.legs.map((l) => l.status);
    expect(statuses).toContain("fail");
    expect(statuses).toContain("ok");
    // No leg crosses land.
    const c = b.route.coordinates;
    expect(
      c.slice(1).some((p, i) => legVerdict(chart, c[i] as LonLat, p, 40).flags.includes("LAND"))
    ).toBe(false);
  });

  test("on, but the wall is land end to end: still refused, never over land", async () => {
    expect((await run(wall("land"), true)).status).toBe(422);
  });

  test("on, but the gap is an entry-prohibited area: refused, the hard rule is not traded", async () => {
    const chart = wall();
    chart.closed = [{ x: 2500, y: 0, r: 300, flag: "ENTRY_PROHIBITED" }];
    expect((await run(chart, true)).status).toBe(422);
  });

  test("the fallback crosses only flags it knows; anything else stays closed", () => {
    for (const flag of ["UNASSESSED", "NOT_FOR_NAVIGATION", "DREDGED", "WATER_LEVEL_FALLBACK"]) {
      expect(crossable({ flags: [flag] })).toBe(true);
    }
    // A leg under a bridge, held to the fairway gap's strip: the strict rule passes it, and a
    // lowest-risk route that takes it is not refused for it.
    expect(crossable({ flags: ["SWEPT", "NOT_FOR_NAVIGATION", "FAIRWAY_GAP"] })).toBe(true);
    expect(berthable({ flags: ["LAND", "FAIRWAY_GAP"] })).toBe(true);
    for (const flag of [
      "LAND",
      "NO_COVERAGE",
      "BOX_TOO_LARGE",
      "TOO_LONG_FOR_ONE_LEG",
      "ENTRY_PROHIBITED"
    ]) {
      expect(crossable({ flags: ["UNASSESSED", flag] })).toBe(false);
    }
  });

  test("a berth leg may touch its quay, but nothing a hard rule or no chart closes", () => {
    expect(berthable({ flags: ["LAND", "UNASSESSED"] })).toBe(true);
    for (const flag of ["ENTRY_PROHIBITED", "NO_COVERAGE", "BOX_TOO_LARGE"]) {
      expect(berthable({ flags: ["LAND", flag] })).toBe(false);
    }
  });

  test("a leg whose own line crosses land is no berth leg, and nothing the fallback crosses", () => {
    expect(berthable({ flags: ["LAND", "LAND_CROSSED"] })).toBe(false);
    expect(berthable({ flags: ["LAND", "LAND_CROSSED", "NOT_FOR_NAVIGATION"] })).toBe(false);
    expect(crossable({ flags: ["LAND_CROSSED"] })).toBe(false);
  });

  test("the test chart flags a line through land, not one that leaves the land at its end", () => {
    const chart: Chart = { obstacles: [{ x: 0, y: 30, r: 6 }] };
    // Across the obstacle, and from alongside it through it.
    expect(legVerdict(chart, at(0, 0), at(0, 60), 10).flags).toEqual(["LAND", "LAND_CROSSED"]);
    expect(legVerdict(chart, at(0, 22), at(0, 60), 10).flags).toEqual(["LAND", "LAND_CROSSED"]);
    // From alongside it, away; from on its edge, out; past it with the corridor on it.
    expect(legVerdict(chart, at(0, 22), at(0, -20), 10).flags).toEqual(["LAND"]);
    expect(legVerdict(chart, at(0, 26), at(0, -20), 10).flags).toEqual(["LAND"]);
    expect(legVerdict(chart, at(-40, 20), at(40, 20), 10).flags).toEqual(["LAND"]);
  });

  test("a berth leg along a quay into uncharted water keeps NO_COVERAGE and is closed", () => {
    // The test oracle reports every flag a corridor meets, as the route check does.
    const chart: Chart = {
      obstacles: [{ x: 0, y: 60, r: 50 }],
      unverified: [{ x: 300, y: 0, r: 50 }]
    };
    const v = legVerdict(chart, at(0, 0), at(300, 0), 40);
    expect(v.status).toBe("fail");
    expect(v.flags).toEqual(["LAND", "NO_COVERAGE"]);
    expect(berthable(v)).toBe(false);
  });

  test("on, with open water round the shallows: the strict route, no fallback", async () => {
    const r = await run({ obstacles: [], shallows: [{ x: 2500, y: 0, r: 600 }] }, true);
    const b = r.body as Body;
    expect(b.status).toBe("ok");
    expect(b.fallback).toBeUndefined();
  });

  test("property: a fallback route never has a leg over land", async () => {
    const circle = fc.record({
      x: fc.integer({ min: 800, max: 4200 }),
      y: fc.integer({ min: -2500, max: 2500 }),
      r: fc.integer({ min: 60, max: 700 })
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(circle, { maxLength: 6 }),
        fc.array(circle, { maxLength: 6 }),
        async (land, shoal) => {
          const clear = (k: Circle) =>
            Math.hypot(k.x, k.y) > k.r + 600 && Math.hypot(k.x - 5000, k.y) > k.r + 600;
          const chart = { obstacles: land.filter(clear), shallows: shoal.filter(clear) };
          const r = await run(chart, true);
          if (r.status !== 200) {
            return true;
          }
          const c = (r.body as Body).route.coordinates;
          return !c
            .slice(1)
            .some((p, i) => legVerdict(chart, c[i] as LonLat, p, 40).flags.includes("LAND"));
        }
      ),
      { numRuns: 40 }
    );
  });
});
