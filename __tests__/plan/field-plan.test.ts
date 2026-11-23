import fc from "fast-check";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { plan } from "../../src/plan/plan";
import { disc, tileAt, tiledApi } from "../helpers/tiled-oracle";

/**
 * The raster field under a whole plan (`search/field.ts`): on a chart of tiles, as
 * signalk-underkeel's is, the plan made with the session's raster is the plan made without it,
 * leg for leg, for fewer questions asked of the chart.
 */

const NOW = Date.parse("2026-11-19T07:00:00Z");
const NEVER = new AbortController().signal;

/** Start and destination 4.6 km apart (240 tiles), in open water. */
const FROM = tileAt(20.5, 120.5);
const TO = tileAt(260.5, 130.5);

async function both(land: [number, number][], over: { xteLimit?: number; narrows?: boolean } = {}) {
  const run = async (raster: boolean) => {
    const api = tiledApi(land, raster);
    const r = await plan(
      api,
      { from: FROM, to: TO, departure: NOW, speed: 3, xteLimit: 30, ...over },
      NEVER,
      NOW,
      DEFAULT_PLAN
    );
    return { r, api };
  };
  return { exact: await run(false), field: await run(true) };
}

/** A reply's body less what counts the questions asked. */
const sameBut = (body: unknown): unknown =>
  JSON.parse(JSON.stringify(body, (k, v: unknown) => (k === "work" ? undefined : v)));

describe("a plan with the session's raster", () => {
  test("round an island and through a sound: the same route as without, for fewer legs asked", async () => {
    // An island across the direct line, and a sound two tiles wide between two more.
    const land = [...disc(140, 125, 28), ...disc(200, 96, 20), ...disc(200, 140, 20)];
    const { exact, field } = await both(land);
    expect(exact.r.status).toBe(200);
    expect(sameBut(field.r.body)).toEqual(sameBut(exact.r.body));
    expect(field.api.asked.blocks).toBeGreaterThan(0);
    expect(exact.api.asked.blocks).toBe(0);
    expect(field.api.asked.legs).toBeLessThan(exact.api.asked.legs / 2);
    expect(field.api.asked.boxes).toBeLessThan(exact.api.asked.boxes / 2);
  });

  test("a wall with no way through: the same refusal", async () => {
    const wall: [number, number][] = [];
    for (let y = -400; y <= 600; y++) {
      wall.push([140, y], [141, y]);
    }
    const { exact, field } = await both(wall);
    expect(exact.r.status).toBe(422);
    expect(sameBut(field.r.body)).toEqual(sameBut(exact.r.body));
  });

  test("any islands, with narrows and without: the same plan (property)", async () => {
    const island = fc.tuple(
      fc.integer({ min: 50, max: 230 }),
      fc.integer({ min: 60, max: 190 }),
      fc.integer({ min: 2, max: 24 })
    );
    const differing: string[] = [];
    await fc.assert(
      fc.asyncProperty(
        fc.array(island, { minLength: 1, maxLength: 7 }),
        fc.boolean(),
        async (islands, narrows) => {
          const land = islands.flatMap(([x, y, r]) => disc(x, y, r));
          const { exact, field } = await both(land, { narrows });
          if (JSON.stringify(sameBut(field.r.body)) !== JSON.stringify(sameBut(exact.r.body))) {
            differing.push(JSON.stringify({ islands, narrows }));
          }
        }
      ),
      { numRuns: 12 }
    );
    expect(differing).toEqual([]);
  });
});
