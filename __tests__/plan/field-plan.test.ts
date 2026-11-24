import fc from "fast-check";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { settled } from "../../src/plan/narrows";
import { plan } from "../../src/plan/plan";
import { OK_ONLY } from "../../src/search/passes";
import { disc, TILE_M, tileAt, tiledApi } from "../helpers/tiled-oracle";

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

/**
 * A work budget no plan here reaches: the plan without the raster asks more of the chart for the
 * same route, and under the default budget its refinement could stop short of the raster's.
 */
const UNBOUNDED = { ...DEFAULT_PLAN, maxWork: 20_000_000 };

async function both(land: [number, number][], over: { xteLimit?: number; narrows?: boolean } = {}) {
  const run = async (raster: boolean) => {
    const api = tiledApi(land, raster);
    const r = await plan(
      api,
      { from: FROM, to: TO, departure: NOW, speed: 3, xteLimit: 30, ...over },
      NEVER,
      NOW,
      UNBOUNDED
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
      {
        numRuns: 12,
        // Under the default budget the plan without the raster stopped refining short here.
        examples: [
          [
            [
              [199, 141, 24],
              [185, 108, 22],
              [136, 100, 11],
              [99, 85, 16],
              [98, 132, 21],
              [192, 89, 20]
            ],
            true
          ]
        ]
      }
    );
    expect(differing).toEqual([]);
  });
});

describe("a leg too long to check as one", () => {
  test("is never settled on the raster: the leg check's refusal, the chart not asked", async () => {
    const api = tiledApi([], true);
    // A 1 km half-width: a 12 km leg's corridor is 28 km², an 8 km leg's 20 km².
    const params = { departure: NOW, until: NOW + 3_600_000, speed: 3, xteLimit: 990 };
    const r = await api.session(params, NEVER, (s) => {
      const check = settled(s, OK_ONLY);
      const long = check(tileAt(0, 120), tileAt(12_000 / TILE_M, 120));
      const short = check(tileAt(0, 120), tileAt(8000 / TILE_M, 120));
      return Promise.resolve({ long, short });
    });
    expect(r.ok && r.value.long).toMatchObject({
      status: "unverified",
      flags: ["TOO_LONG_FOR_ONE_LEG"]
    });
    expect(r.ok && r.value.short.status).toBe("ok");
    expect(api.asked.legs).toBe(0);
    expect(api.asked.blocks).toBeGreaterThan(0);
  });
});
