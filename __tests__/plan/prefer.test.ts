import type { LonLat } from "../../src/foundation/geo";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { plan } from "../../src/plan/plan";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, syntheticApi, xy } from "../helpers/synthetic-oracle";

/**
 * Preference lines (plan §4.4, R4c): in open water a route keeps to a leading line where that
 * costs little more distance, leaves one that would cost much more, and keeps to starboard of a
 * two-way fairway line, on the side the boat's way puts it.
 */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");

interface Body {
  length?: number;
  route?: { coordinates: LonLat[] };
  check?: { legs: { status: string }[] };
}

async function planned(chart: Chart, from: [number, number], to: [number, number], over = {}) {
  const r = await plan(
    syntheticApi(chart, { features: ["objects"] }),
    { from: at(...from), to: at(...to), departure: NOW, speed: 3 },
    NEVER,
    NOW,
    { ...DEFAULT_PLAN, ...over }
  );
  const body = r.body as Body;
  return { r, body, points: (body.route?.coordinates ?? []).map(xy) };
}

/** The route's greatest distance north of y = 0 (negative: south), metres. */
const furthest = (points: [number, number][]) =>
  points.reduce((m, p) => (Math.abs(p[1]) > Math.abs(m) ? p[1] : m), 0);

/** A leading line from the start up to (2000, h) and down to the destination. */
const bent = (h: number): Chart => ({
  obstacles: [],
  lines: [
    {
      class: "NAVLNE",
      points: [
        [0, 0],
        [2000, h],
        [4000, 0]
      ]
    }
  ]
});

describe("preference lines", () => {
  test("with no line, the direct line is the route", async () => {
    const { points } = await planned({ obstacles: [] }, [0, 0], [4000, 0]);
    expect(points).toHaveLength(2);
  });

  test("a leading line 1 % longer than the direct line is followed", async () => {
    const { r, body, points } = await planned(bent(300), [0, 0], [4000, 0]);
    expect(r.status).toBe(200);
    // Out to the line's bend, within its reach.
    expect(furthest(points)).toBeGreaterThan(300 - 40);
    expect(body.check?.legs.every((l) => l.status === "ok")).toBe(true);
  });

  test("a line 40 % longer than the direct line is left", async () => {
    const { points } = await planned(bent(1800), [0, 0], [4000, 0]);
    expect(Math.abs(furthest(points))).toBeLessThan(100);
  });

  test("without the preference the line is not followed", async () => {
    const { points } = await planned(bent(300), [0, 0], [4000, 0], { preferWeight: 0 });
    expect(points).toHaveLength(2);
  });

  test("a two-way line is kept to starboard: south of it going east, north going west", async () => {
    const twoWay: Chart = {
      obstacles: [],
      lines: [
        {
          class: "NAVLINE",
          twoWay: true,
          points: [
            [-500, 0],
            [4500, 0]
          ]
        }
      ]
    };
    const over = { starboardOffset: 100 };
    const east = await planned(twoWay, [0, 0], [4000, 0], over);
    const west = await planned(twoWay, [4000, 0], [0, 0], over);
    expect(furthest(east.points)).toBeLessThan(-60);
    expect(furthest(west.points)).toBeGreaterThan(60);
  });

  test("a region too large for the provider to list is planned without lines", async () => {
    const api = syntheticApi(bent(300), { features: ["objects"] });
    const session = api.session.bind(api);
    api.session = (params, signal, job) =>
      session(params, signal, (s) =>
        job({
          ...s,
          objects: () => {
            throw new RangeError("objects box over 40000 km²");
          }
        })
      );
    const r = await plan(
      api,
      { from: at(0, 0), to: at(4000, 0), departure: NOW, speed: 3 },
      NEVER,
      NOW
    );
    expect(r.status).toBe(200);
    expect((r.body as Body).route?.coordinates).toHaveLength(2);
  });
});
