import type { LonLat } from "../../src/foundation/geo";
import { legsOf } from "../../src/plan/gate";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { plan } from "../../src/plan/plan";
import { passes } from "../../src/search/passes";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, legStatus, syntheticApi } from "../helpers/synthetic-oracle";

/**
 * The fairway stage (plan §4.1 step 15): a sound narrower than any square the search can free,
 * where a leg along its charted line passes, is taken along the line.
 */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");

/** Land across x = 3000, its one gap a sound 26 m wide on y = 0, and the sea closed past it. */
function sound(lines = true): Chart {
  return {
    obstacles: [
      { x: 3000, y: 1513, r: 1500 },
      { x: 3000, y: -1513, r: 1500 },
      { x: 3000, y: 9000, r: 6600 },
      { x: 3000, y: -9000, r: 6600 }
    ],
    ...(lines && {
      lines: [
        {
          class: "NAVLINE",
          points: [
            [0, 0],
            [6000, 0]
          ] as [number, number][],
          designDraft: 2.1
        }
      ]
    })
  };
}

async function planned(chart: Chart, draft?: number) {
  return plan(
    syntheticApi(chart),
    {
      from: at(0, 0),
      to: at(6000, 0),
      departure: NOW,
      speed: 3,
      xteLimit: 30,
      ...(draft !== undefined && { draft })
    },
    NEVER,
    NOW,
    { ...DEFAULT_PLAN, maxWork: 5_000_000 }
  );
}

describe("the fairway stage", () => {
  test("a sound no square fits is passed along its charted line, each leg at its corridor", async () => {
    const chart = sound();
    // A 10 m square with the narrow corridor round it does not fit; a leg along the line does.
    expect(legStatus(chart, at(2900, 0), at(3100, 0), 10)).toBe("ok");
    const r = await planned(chart);
    expect(r.status).toBe(200);
    const body = r.body as {
      route: { coordinates: LonLat[] };
      check: { legs: { status: string; xteLimit?: number }[] };
    };
    const c = body.route.coordinates;
    expect(
      body.check.legs.every(
        (l, i) =>
          legStatus(chart, c[i] as LonLat, c[i + 1] as LonLat, (l.xteLimit ?? 30) + 10) === "ok"
      )
    ).toBe(true);
  });

  test("without the line, or with one laid out for less than the draft, there is no way", async () => {
    expect((await planned(sound(false))).status).toBe(422);
    expect((await planned(sound(), 2.5)).status).toBe(422);
  });
});

describe("flags that describe the water", () => {
  test("do not keep an otherwise accepted unverified leg out", () => {
    const rule = { accept: ["NOT_FOR_NAVIGATION"], probability: 0.01 };
    const leg = (flags: string[]) => ({ status: "unverified" as const, risk: 0.001, flags });
    expect(passes(leg(["DREDGED", "NOT_FOR_NAVIGATION", "PILOTAGE"]), rule)).toBe(true);
    expect(passes(leg(["DREDGED"]), rule)).toBe(false);
    expect(passes(leg(["DREDGED", "UNASSESSED"]), rule)).toBe(false);
  });

  test("a pilotage part's legs are timed in a session of their own (`gate.ts`)", () => {
    const legs = legsOf(
      [
        { kind: "narrows", coordinates: [at(0, 0), at(100, 0)], xteLimit: 0, pilotage: true },
        { kind: "harbour", end: "end", coordinates: [at(100, 0), at(200, 0)], xteLimit: 0 }
      ],
      3
    );
    expect(legs.map((l) => [l.xteLimit, l.pilotage])).toEqual([
      [0, true],
      [0, undefined]
    ]);
  });
});
