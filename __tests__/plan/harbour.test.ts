import type { LonLat } from "../../src/foundation/geo";
import { haversine } from "../../src/foundation/geo";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { plan } from "../../src/plan/plan";
import { joined } from "../../src/plan/proof";
import type { Chart, Circle } from "../helpers/synthetic-oracle";
import { at, legStatus, legVerdict, syntheticApi, xy } from "../helpers/synthetic-oracle";

/**
 * The harbour stage and berth legs (plan §4.1): an end in a harbour narrower than the
 * request's corridor is planned out at the harbour corridor, and a point alongside a quay
 * leaves by a short berth leg the route check marks.
 */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");

/**
 * The harbour stage alone: narrows (`narrows.ts`) would plan an inlet the harbour corridor joins
 * without one; `narrows.test.ts` covers that.
 */
const HARBOUR = { ...DEFAULT_PLAN, narrows: false };

/** A closed inlet 50 m wide, from x = -40 to x = 600 along y = 0, open to the sea east of it. */
function inlet(): Circle[] {
  const walls: Circle[] = [];
  for (let x = -60; x <= 600; x += 10) {
    walls.push({ x, y: 40, r: 15 }, { x, y: -40, r: 15 });
  }
  walls.push({ x: -60, y: 0, r: 40 });
  return walls;
}

interface Body {
  status: string;
  underway?: string;
  route: { coordinates: LonLat[] };
  check: {
    legs: { status: string; part: string; xteLimit?: number; berth?: true; flags: string[] }[];
    parts: { part: string; end?: string; xteLimit?: number; legs: [number, number] }[];
  };
  berths?: { end: string; leg: number; length: number }[];
  reason?: string;
}

async function planFrom(from: LonLat, opts = HARBOUR, closed: Chart["closed"] = []) {
  const chart: Chart = { obstacles: inlet(), closed };
  const api = syntheticApi(chart);
  const r = await plan(
    api,
    { from, to: at(3000, 0), departure: NOW, speed: 3, xteLimit: 30 },
    NEVER,
    NOW,
    opts
  );
  return { r, body: r.body as Body, api, chart };
}

/**
 * A slot 16 m wide along y = 0, closed at both ends, between a wall south of it and a
 * breakwater 8 m wide north of it, with open sea north of the breakwater. The harbour corridor,
 * 10 m each side, fits nowhere in the slot: the nearest water the check passes is 26 m north of
 * its middle, behind the breakwater.
 */
function slot(): Circle[] {
  const land: Circle[] = [];
  for (let x = 0; x <= 600; x += 4) {
    land.push({ x, y: 12, r: 4 }, { x, y: -48, r: 40 });
  }
  land.push({ x: -40, y: 0, r: 40 }, { x: 640, y: 0, r: 40 });
  return land;
}

describe("harbour stage", () => {
  test("a berth leg is not taken through a breakwater to the water behind it", async () => {
    const chart: Chart = { obstacles: slot() };
    const from = at(300, 0);
    // The stub a berth leg would be: 30 m north, through the breakwater, to water that passes.
    const through = at(300, 30);
    expect(legStatus(chart, through, at(300, 200), 10)).toBe("ok");
    expect(haversine(from, through)).toBeLessThanOrEqual(DEFAULT_PLAN.berthMetres);
    expect(legVerdict(chart, from, through, 10).flags).toEqual(["LAND", "LAND_CROSSED"]);
    for (const fallback of [false, true]) {
      const r = await plan(
        syntheticApi(chart),
        { from, to: at(300, 400), departure: NOW, speed: 3, xteLimit: 30, fallback },
        NEVER,
        NOW,
        HARBOUR
      );
      const body = r.body as Body;
      // Refused, with the reason: the slot has no way out the check passes or may cross.
      expect(r.status).toBe(422);
      expect(body.reason).toMatch(/no water the route check passes within 500 m of the start/);
      expect(body.reason).toMatch(/LAND/);
    }
  });

  test("an end in a narrow inlet is planned out at the harbour corridor, then the route", async () => {
    const { r, body, api, chart } = await planFrom(at(20, 0));
    expect(r.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.check.parts.map((p) => [p.part, p.end, p.xteLimit])).toEqual([
      ["harbour", "start", 0],
      ["route", undefined, 30]
    ]);
    // The harbour part ran in a session of its own at the narrow corridor, and so did the
    // easing of its joint with the route (`joint.ts`).
    expect(api.sessions.map((s) => s.xteLimit)).toEqual([30, 0, 30, 0]);
    // Every leg passes at its own part's corridor: 10 m in the inlet, 40 m outside.
    const c = body.route.coordinates;
    const ok = body.check.legs.every(
      (l, i) =>
        legStatus(chart, c[i] as LonLat, c[i + 1] as LonLat, (l.xteLimit ?? 30) + 10) === "ok"
    );
    expect(ok).toBe(true);
    expect(body.berths).toBeUndefined();
    // The joint is eased: out of the inlet's mouth at x = 600 the route goes on east, not back
    // west to the free water the main search named as the handover (370 m east, north of the
    // inlet), which cost 500 m more. No leg has no length.
    expect(c).toHaveLength(body.check.legs.length + 1);
    const xs = c.map((p) => xy(p)[0]);
    expect(xs.every((x, i) => i === 0 || x > (xs[i - 1] as number))).toBe(true);
    const length = c.slice(1).reduce((sum, p, i) => sum + haversine(c[i] as LonLat, p), 0);
    expect(length).toBeLessThan(3100);
  });

  test("a point alongside the quay leaves by a berth leg the route check marks", async () => {
    // 7 m from the north wall: even the 10 m harbour corridor touches it.
    const from = at(300, 18);
    const { r, body, chart } = await planFrom(from);
    expect(r.status).toBe(200);
    expect(legStatus(chart, from, at(301, 18), 10)).toBe("fail");
    expect(body.berths).toHaveLength(1);
    const berth = body.berths?.[0];
    expect(berth).toMatchObject({ end: "start", leg: 0 });
    expect(berth?.length).toBeLessThanOrEqual(DEFAULT_PLAN.berthMetres + 1);
    const first = body.check.legs[0];
    // The berth leg's status is the route check's: it touches the quay.
    expect(first).toMatchObject({ berth: true, status: "fail", part: "harbour" });
    expect(first?.flags).toContain("LAND");
    // Underway, past the berth leg, the route passes; the plan's own status stays the worst leg's.
    expect(body.underway).toBe("ok");
    expect(body.status).toBe("fail");
    expect(body.check.legs.slice(1).every((l) => l.status === "ok")).toBe(true);
    // The berth leg ends where the harbour corridor clears the wall.
    const q = xy(body.route.coordinates[1] as LonLat);
    expect(q[1]).toBeLessThanOrEqual(15 + 1);
  });

  test("a berth leg is never taken into an entry-prohibited area, quay or not", async () => {
    // The same berth, but the quayside it lies at is closed to entry.
    const closed = [{ x: 300, y: 18, r: 4, flag: "ENTRY_PROHIBITED" }];
    const { r, body } = await planFrom(at(300, 18), HARBOUR, closed);
    expect(r.status).toBe(422);
    expect(body.berths).toBeUndefined();
  });

  test("without berth legs the same point is refused, naming the harbour stage", async () => {
    const { r, body } = await planFrom(at(300, 18), { ...HARBOUR, berthMetres: 0 });
    expect(r.status).toBe(422);
    expect(body.reason).toMatch(/harbour stage found no way out from the start at xte 0 m/);
  });

  test("without a harbour stage the inlet end is refused as before", async () => {
    const { r, body, api } = await planFrom(at(20, 0), { ...HARBOUR, harbourMetres: 0 });
    expect(r.status).toBe(422);
    expect(body.reason).toMatch(/within 500 m of the start/);
    expect(api.sessions).toHaveLength(1);
  });

  test("an end with no free water within harbourMetres (open sea is 95 m off) is refused", async () => {
    const { r } = await planFrom(at(20, 0), { ...HARBOUR, harbourMetres: 50 });
    expect(r.status).toBe(422);
  });

  test("every stage draws on the plan's one work budget", async () => {
    const full = await planFrom(at(20, 0));
    const used = (full.body as unknown as { work: number }).work;
    expect(full.r.status).toBe(200);
    // With the budget at 60 % of what the four sessions used together, a later stage
    // reaches the limit and the plan is refused, not offered past it.
    expect(full.api.sessions).toHaveLength(4);
    const tight = await planFrom(at(20, 0), { ...HARBOUR, maxWork: Math.floor(used * 0.6) });
    expect(tight.r.status).toBe(422);
    expect(tight.body.reason).toMatch(/work limit/);
  });

  test("the harbour legs are proved from the time the boat reaches them", async () => {
    const chart = { obstacles: inlet() };
    const api = syntheticApi(chart);
    const departures: string[] = [];
    const check = api.routeCheck.bind(api);
    api.routeCheck = (b, signal) => {
      departures.push((b as { departure: string }).departure);
      return check(b, signal);
    };
    // Into the inlet: the route part first, then the harbour part at the destination.
    const r = await plan(
      api,
      { from: at(3000, 0), to: at(20, 0), departure: NOW, speed: 3, xteLimit: 30 },
      NEVER,
      NOW,
      HARBOUR
    );
    expect(r.status).toBe(200);
    const body = r.body as Body;
    expect(body.check.parts.map((p) => p.part)).toEqual(["route", "harbour"]);
    const [routeLegs] = [body.check.parts[0]?.legs as [number, number]];
    const c = body.route.coordinates;
    const routeMetres = c
      .slice(0, routeLegs[1] + 2)
      .reduce((s, p, i, a) => (i === 0 ? 0 : s + haversine(a[i - 1] as LonLat, p)), 0);
    expect(departures[0]).toBe(new Date(NOW).toISOString());
    const second = Date.parse(departures[1] as string);
    expect(Math.abs(second - (NOW + (routeMetres / 3) * 1000))).toBeLessThan(2000);
  });

  test("each handover point appears once: the route has one point more than its legs", async () => {
    for (const [from, to] of [
      [at(20, 0), at(3000, 0)],
      [at(3000, 0), at(20, 0)],
      [at(300, 18), at(3000, 0)]
    ] as [LonLat, LonLat][]) {
      const r = await plan(
        syntheticApi({ obstacles: inlet() }),
        { from, to, departure: NOW, speed: 3, xteLimit: 30 },
        NEVER,
        NOW
      );
      const body = r.body as Body;
      expect(body.route.coordinates).toHaveLength(body.check.legs.length + 1);
      expect(body.route.coordinates[0]).toEqual(from);
      expect(body.route.coordinates[body.route.coordinates.length - 1]).toEqual(to);
    }
    // Two parts meeting at a point their frames moved in the last bits join there once.
    const a: LonLat = [22, 60];
    const b: LonLat = [22.01, 60.01];
    const c: LonLat = [22.02, 60.02];
    const parts = [
      { kind: "harbour" as const, coordinates: [a, b] },
      { kind: "route" as const, coordinates: [[b[0] + 1e-13, b[1] - 1e-13] as LonLat, c] }
    ];
    expect(joined(parts)).toHaveLength(3);
  });

  test("the search for handovers stops at the search's share of the work", async () => {
    const { r, body, api } = await planFrom(at(20, 0), { ...HARBOUR, maxWork: 3000 });
    expect(r.status).toBe(422);
    expect(body.reason).toMatch(/work limit/);
    expect(api.sessions).toHaveLength(1);
  });
});
