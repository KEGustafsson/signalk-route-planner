import type { LonLat } from "../../src/foundation/geo";
import type { PlanningApiV1, Session, SessionParams } from "../../src/oracle/contract";
import { fairwayRoute } from "../../src/plan/fairway";
import { legsOf } from "../../src/plan/gate";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { plan } from "../../src/plan/plan";
import { OK_ONLY, passes } from "../../src/search/passes";
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

describe("lines meeting at a T", () => {
  test("a line that begins on another's leg joins it there", async () => {
    // A runs north–south past the start; B begins on A's leg, at no point of A, and runs east
    // through the sound to the destination.
    const chart: Chart = {
      ...sound(false),
      lines: [
        {
          class: "NAVLINE",
          points: [
            [0, -3000],
            [0, 3000]
          ],
          designDraft: 2.1
        },
        {
          class: "NAVLINE",
          points: [
            [0, 0],
            [6000, 0]
          ],
          designDraft: 2.1
        }
      ]
    };
    const r = await plan(
      syntheticApi(chart),
      { from: at(-300, 1000), to: at(6000, 0), departure: NOW, speed: 3, xteLimit: 30 },
      NEVER,
      NOW,
      { ...DEFAULT_PLAN, maxWork: 5_000_000 }
    );
    expect(r.status).toBe(200);
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

describe("the way along the lines at the work limit", () => {
  // One line of 20 legs from a to b, every leg passing, each check one work unit.
  const points: LonLat[] = Array.from({ length: 21 }, (_, i) => [22 + i * 0.001, 60]);
  function lineSession(): { session: Session; checks: () => number } {
    let work = 0;
    const session: Session = {
      halfWidth: 10,
      box: () => ({ status: "ok", risk: 0, flags: [] }),
      segment: () => {
        work++;
        return { status: "ok", risk: 0, flags: [] };
      },
      objects: () => [{ class: "NAVLINE", geometry: { type: "LineString", coordinates: points } }],
      work: () => work,
      pause: () => Promise.resolve()
    };
    return { session, checks: () => work };
  }
  const ends: [LonLat, LonLat] = [points[0] as LonLat, points[20] as LonLat];

  test("checks no leg once the work is spent, and offers no way with legs unchecked", () => {
    const { session, checks } = lineSession();
    const way = fairwayRoute(session, ends, {
      rule: OK_ONLY,
      reach: 1,
      exhausted: () => checks() >= 5
    });
    expect([way, checks()]).toEqual([undefined, 5]);
  });

  test("within the work, is the way once every leg is checked", () => {
    const { session, checks } = lineSession();
    const way = fairwayRoute(session, ends, { rule: OK_ONLY, reach: 1, exhausted: () => false });
    expect([way?.length, checks()]).toEqual([21, 20]);
  });
});

describe("pilotage", () => {
  // The sound is 16 m wide: the harbour corridor's 10 m buffer does not fit, a pilotage buffer
  // of 5 m in its swept water does (the land 5 m farther off). The destination lies at a quay.
  const quay = { x: 6000, y: 15, r: 8 };
  const chart = (buffer: number): Chart => ({
    obstacles: [
      { x: 3000, y: 1508, r: 1500 - buffer },
      { x: 3000, y: -1508, r: 1500 - buffer },
      { x: 3000, y: 9000, r: 6600 },
      { x: 3000, y: -9000, r: 6600 },
      quay
    ],
    lines: [
      {
        class: "NAVLINE",
        points: [
          [0, 0],
          [6000, 0]
        ]
      }
    ]
  });

  /** A provider with feature "pilotage", its sessions' params and route checks recorded. */
  function piloting() {
    const plain = syntheticApi(chart(0));
    const swept = syntheticApi(chart(5));
    const sessions: SessionParams[] = [];
    const checks: { pilotage?: boolean; route: { coordinates: LonLat[] } }[] = [];
    const api: PlanningApiV1 = {
      ...plain,
      features: ["objects", "pilotage"],
      session: (params, signal, job) => {
        sessions.push(params);
        return (params.pilotage ? swept : plain).session(params, signal, job);
      },
      routeCheck: (body, signal) => {
        const b = body as (typeof checks)[number];
        checks.push(b);
        return (b.pilotage ? swept : plain).routeCheck(body, signal);
      }
    };
    return { api, sessions, checks };
  }

  test("a sound passed in swept water is planned and proved with pilotage, the harbour without", async () => {
    const p = piloting();
    expect(legStatus(chart(0), at(2900, 0), at(3100, 0), 10)).toBe("fail");
    const r = await plan(
      p.api,
      { from: at(0, 0), to: at(6000, 0), departure: NOW, speed: 3, xteLimit: 30 },
      NEVER,
      NOW,
      { ...DEFAULT_PLAN, maxWork: 5_000_000 }
    );
    expect(r.status).toBe(200);
    const parts = (r.body as { check: { parts: { part: string }[] } }).check.parts;
    expect(parts.map((q) => q.part)).toContain("narrows");
    expect(parts[parts.length - 1]?.part).toBe("harbour");
    expect(p.sessions.some((s) => s.pilotage === true)).toBe(true);
    expect(p.checks.some((c) => c.pilotage === true)).toBe(true);
    // The harbour part at the quay, last, is checked as it was planned: without pilotage.
    expect(p.checks[p.checks.length - 1]?.pilotage).toBeUndefined();
  });
});
