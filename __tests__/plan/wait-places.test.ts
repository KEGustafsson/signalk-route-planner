import type { LonLat } from "../../src/foundation/geo";
import type { ChartObject, Session, Verdict } from "../../src/oracle/contract";
import type { Leg } from "../../src/plan/gate";
import { SLOT_MS } from "../../src/plan/gate";
import { passPlaces, placesAlong } from "../../src/plan/wait-places";
import type { Leave } from "../../src/plan/leave-times";
import { waitsAfter } from "../../src/plan/leave-times";
import { at, xy } from "../helpers/synthetic-oracle";

/**
 * Waiting places (plan §4.3, R3c) against a stub session: which boxes and ways pass is set
 * per test, so the choice of places can be held to what passes.
 */

const HORIZON = { start: 0, end: 12 * 3_600_000 };
const MIN = 60_000;
const verdict = (ok: boolean): Verdict => ({ status: ok ? "ok" : "fail", risk: 0, flags: [] });

function stub(o: {
  boxOk?: (centre: [number, number]) => boolean;
  areas?: LonLat[][][];
  segments?: [LonLat, LonLat][];
}): Session {
  return {
    halfWidth: 10,
    box: (sw, ne) => {
      const [x1, y1] = xy(sw);
      const [x2, y2] = xy(ne);
      return verdict(o.boxOk ? o.boxOk([(x1 + x2) / 2, (y1 + y2) / 2]) : true);
    },
    segment: (a, b) => {
      o.segments?.push([a, b]);
      return verdict(true);
    },
    objects: (): ChartObject[] =>
      (o.areas ?? []).map((rings) => ({
        class: "ACHARE",
        geometry: { type: "MultiPolygon", coordinates: [rings] }
      })),
    work: () => 0,
    pause: () => Promise.resolve()
  };
}

/** A route along y = 0 with points every 1000 m, sailed at 1 m/s. */
function legsAlong(n: number): Leg[] {
  return Array.from({ length: n }, (_, j) => ({
    a: at(j * 1000, 0),
    b: at((j + 1) * 1000, 0),
    from: j * 1000_000,
    to: (j + 1) * 1000_000
  }));
}

const square = (x: number, y: number, h: number): LonLat[] => [
  at(x - h, y - h),
  at(x + h, y - h),
  at(x + h, y + h),
  at(x - h, y + h),
  at(x - h, y - h)
];

describe("waiting places", () => {
  test("a point at a route point without room to swing is reached by its way, not waited at on the route", async () => {
    const legs = legsAlong(3);
    const segments: [LonLat, LonLat][] = [];
    const point = at(1000, 0.5);
    const s = stub({
      boxOk: ([x, y]) => !(Math.abs(x - 1000) < 0.1 && Math.abs(y) < 0.1),
      segments
    });
    const places = await placesAlong(
      s,
      legs,
      HORIZON,
      { swing: 50, reach: 1852, points: [point] },
      1e9
    );
    const p = places?.[1];
    expect(p?.onRoute).toBe(false);
    expect(p?.designated?.at).toEqual(point);
    expect(p?.designated?.detour).toBeGreaterThan(0);
    expect(segments).toHaveLength(1);
  });

  test("each place that passes is weighed: the nearest is kept beside the one ranked first", async () => {
    const legs = legsAlong(3);
    const user = at(1000, 1000);
    const s = stub({
      boxOk: ([x, y]) => !(Math.abs(x - 1000) < 0.1 && Math.abs(y) < 0.1),
      areas: [[square(1000, -100, 20)]]
    });
    const places = await placesAlong(
      s,
      legs,
      HORIZON,
      { swing: 10, reach: 1852, points: [user] },
      1e9
    );
    const p = places?.[1];
    expect(p?.designated).toMatchObject({ at: user, kind: "user" });
    expect(p?.nearest?.kind).toBe("anchorage");
    expect(xy(p?.nearest?.at as LonLat)[1]).toBeCloseTo(-100, 0);
    const preferred = passPlaces(places ?? [], true, legs, 1)[1];
    const nearest = passPlaces(places ?? [], true, legs, 1, true)[1];
    expect(preferred?.kind).toBe("user");
    expect(nearest?.kind).toBe("anchorage");
    expect(nearest?.detourMs).toBeLessThan(preferred?.detourMs ?? 0);
  });

  test("a boat may leave as soon as it is back from a detour", () => {
    // Back from a 12-minute detour at minute 17; the next slot boundary, 30, is past the last.
    const here: Leave[] = [{ leave: 5 * MIN, arrive: 5 * MIN, from: 0, departure: 0 }];
    waitsAfter(here, 25 * MIN, 0, [0, SLOT_MS], 12 * MIN);
    expect(here.map((l) => l.leave)).toContain(17 * MIN);
  });
});
