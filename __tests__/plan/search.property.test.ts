import fc from "fast-check";
import type { LonLat } from "../../src/foundation/geo";
import { DEFAULT_PLAN } from "../../src/plan/options";
import type { SearchOutcome } from "../../src/plan/search";
import { searchRoute } from "../../src/plan/search";
import type { Chart, Circle } from "../helpers/synthetic-oracle";
import { at, legStatus, syntheticApi } from "../helpers/synthetic-oracle";

/**
 * Safety properties of the search over random charts (AGENTS.md invariants 1–3):
 * every leg of a route clears every obstacle by the corridor half-width, never
 * crosses unverified water, and a deeper draft (every obstacle larger) never
 * finds a route that the shallower chart rejects.
 */

const NEVER = new AbortController().signal;
const FROM = at(0, 0);
const TO = at(6000, 0);

async function search(chart: Chart): Promise<SearchOutcome> {
  const r = await syntheticApi(chart).session({ departure: 0, until: 1, speed: 3 }, NEVER, (s) =>
    searchRoute(s, FROM, TO, DEFAULT_PLAN)
  );
  if (!r.ok) {
    throw new Error(r.error);
  }
  return r.value;
}

const circle = fc.record({
  x: fc.integer({ min: 500, max: 5500 }),
  y: fc.integer({ min: -2500, max: 2500 }),
  r: fc.integer({ min: 50, max: 700 })
});

/** Circles that leave start and goal in open water. */
const charts = fc
  .record({
    obstacles: fc.array(circle, { minLength: 1, maxLength: 10 }),
    unverified: fc.array(circle, { maxLength: 3 })
  })
  .map((c) => {
    const clear = (k: Circle) =>
      Math.hypot(k.x, k.y) > k.r + 600 && Math.hypot(k.x - 6000, k.y) > k.r + 600;
    return { obstacles: c.obstacles.filter(clear), unverified: c.unverified.filter(clear) };
  });

const statuses = (chart: Chart, coords: LonLat[]) =>
  coords.slice(1).map((b, i) => legStatus(chart, coords[i] as LonLat, b, 40));

describe("search properties", () => {
  test("every leg of a found route passes the chart's own leg check", async () => {
    await fc.assert(
      fc.asyncProperty(charts, async (chart) => {
        const o = await search(chart);
        return !o.ok || statuses(chart, o.coordinates).every((s) => s === "ok");
      }),
      { numRuns: 60 }
    );
  });

  test("a deeper draft never finds a route the shallower chart rejects", async () => {
    await fc.assert(
      fc.asyncProperty(charts, fc.integer({ min: 0, max: 200 }), async (chart, grow) => {
        const deep: Chart = {
          obstacles: chart.obstacles.map((c) => ({ ...c, r: c.r + grow })),
          unverified: chart.unverified
        };
        const d = await search(deep);
        if (!d.ok) {
          return true;
        }
        const shallow = await search(chart);
        // The deep route also clears the shallow chart, and the shallow search finds one too.
        return shallow.ok && statuses(chart, d.coordinates).every((s) => s === "ok");
      }),
      { numRuns: 40 }
    );
  });
});
