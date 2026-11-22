import { parsePlanRequest } from "../../src/api/plan-request";
import type { LonLat } from "../../src/foundation/geo";
import { plan } from "../../src/plan/plan";
import { crossable } from "../../src/search/fallback";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, syntheticApi, xy } from "../helpers/synthetic-oracle";

/**
 * Air height (plan §4.4): a bridge with 18 m clearance over the short way, an open passage the
 * long way round. A 17 m mast passes under the bridge at low water and is kept off it at high
 * water, where it no longer clears it with 0.5 m to spare.
 */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");

/**
 * Land across x = 2000 with the bridged gap at y = 0 and an open gap at y = 2500; `closed`
 * fills the open gap and the sea past the land's ends, so the bridge is the only way through.
 */
function bridged(tide: number, closed = false): Chart {
  const wall = [
    { x: 2000, y: 2525, r: 200 },
    { x: 2000, y: 12_000, r: 6500 },
    { x: 2000, y: -11_000, r: 7200 }
  ];
  return {
    obstacles: [
      { x: 2000, y: 1300, r: 1150 },
      { x: 2000, y: -2000, r: 1880 },
      { x: 2000, y: 4100, r: 1500 },
      ...(closed ? wall : [])
    ],
    // The bridge spans the whole gap (-120..150 m at x = 2000): nothing passes beside it, not
    // even at the narrow corridor of a harbour stage or narrows.
    bridges: [{ x: 2000, y: 0, r: 160, clearance: 18 }],
    tide: () => tide
  };
}

interface Body {
  reason?: string;
  errors?: string[];
  length?: number;
  route?: { coordinates: LonLat[] };
  check?: { legs: { status: string; flags: string[] }[] };
}

async function planned(
  tide: number,
  airHeight?: number,
  features = ["objects"],
  over: { closed?: boolean; fallback?: boolean } = {}
) {
  const r = await plan(
    syntheticApi(bridged(tide, over.closed), { features }),
    {
      from: at(0, 0),
      to: at(4000, 0),
      departure: NOW,
      speed: 3,
      ...(airHeight !== undefined && { airHeight }),
      ...(over.fallback !== undefined && { fallback: over.fallback })
    },
    NEVER,
    NOW
  );
  return { r, body: r.body as Body };
}

/** Whether the route passes x = 2000 within `d` metres of y = 0, under the bridge. */
function underBridge(route: LonLat[], d = 200): boolean {
  return route.slice(1).some((b, i) => {
    const [ax, ay] = xy(route[i] as LonLat);
    const [bx, by] = xy(b);
    if ((ax - 2000) * (bx - 2000) > 0) {
      return false;
    }
    const t = ax === bx ? 0 : (2000 - ax) / (bx - ax);
    return Math.abs(ay + t * (by - ay)) < d;
  });
}

describe("air height under a bridge", () => {
  test("at low water a 17 m mast takes the short way under the 18 m bridge", async () => {
    const { r, body } = await planned(0, 17);
    expect(r.status).toBe(200);
    expect(underBridge(body.route?.coordinates ?? [])).toBe(true);
    expect(body.check?.legs.every((l) => l.status === "ok")).toBe(true);
  });

  test("the bridge fixture blocks the tall mast at high water: it goes the long way round", async () => {
    const low = await planned(0, 17);
    const { r, body } = await planned(1, 17);
    expect(r.status).toBe(200);
    expect(underBridge(body.route?.coordinates ?? [])).toBe(false);
    expect(body.length).toBeGreaterThan(low.body.length as number);
    expect(body.check?.legs.every((l) => l.status === "ok")).toBe(true);
  });

  test("without an air height the bridge holds nothing back", async () => {
    const { body } = await planned(1);
    expect(underBridge(body.route?.coordinates ?? [])).toBe(true);
  });

  test("a provider that does not check bridges is refused an air height, never planned blind", async () => {
    const { r, body } = await planned(1, 17, []);
    expect(r.status).toBe(503);
    expect(body.errors?.[0]).toMatch(/does not check bridges/);
  });

  test("where a bridge too low is the only way, not even the fallback offers a route", async () => {
    const closed = { closed: true, fallback: true };
    const { r, body } = await planned(1, 17, ["objects"], closed);
    expect(r.status).not.toBe(200);
    expect(body.route).toBeUndefined();
    // At low water the mast clears it, and the same fallback request is planned under it.
    const low = await planned(0, 17, ["objects"], closed);
    expect(low.r.status).toBe(200);
    expect(underBridge(low.body.route?.coordinates ?? [])).toBe(true);
  });

  test("the flags a bridge too low and the hard rules carry are never crossable", () => {
    expect(crossable({ flags: ["AIR_DRAFT"] })).toBe(false);
    expect(crossable({ flags: ["CLEARANCE_UNKNOWN"] })).toBe(false);
    expect(crossable({ flags: ["ENTRY_PROHIBITED"] })).toBe(false);
    expect(crossable({ flags: ["TSS_WRONG_WAY", "TRAFFIC_LANE"] })).toBe(false);
    // What the route check only names may be crossed.
    expect(
      crossable({
        flags: ["TRAFFIC_LANE", "AREA_TO_BE_AVOIDED", "ENTRY_RESTRICTED", "CLEARANCE_RISE_ASSUMED"]
      })
    ).toBe(true);
  });

  test("airHeight is 0.1..100 m", () => {
    const base = { from: [22, 60], to: [22.1, 60.1] };
    expect(parsePlanRequest({ ...base, airHeight: 0 }, NOW).ok).toBe(false);
    expect(parsePlanRequest({ ...base, airHeight: 101 }, NOW).ok).toBe(false);
    const ok = parsePlanRequest({ ...base, airHeight: 17 }, NOW);
    expect(ok.ok && ok.value.airHeight).toBe(17);
  });
});
