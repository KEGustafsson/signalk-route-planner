import { plan } from "../../src/plan/plan";
import { arrivalWindow } from "../../src/plan/timing";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, syntheticApi } from "../helpers/synthetic-oracle";

/**
 * The route passable now (plan §4.3, R3d): with no waiting asked for, each square is asked about
 * the water of the time the boat can be there, so a bar the tide covers while the boat crosses
 * it is passed though it dries within the trip's verdict window.
 */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");
const MIN = 60_000;

/** A wall across x = 2500, its one gap a bar at y = 1500 that needs 1 m of water. */
function barred(tide: (t: number) => number): Chart {
  const wall = Array.from({ length: 81 }, (_, i) => ({
    x: 2500,
    y: -8000 + i * 200,
    r: 110
  })).filter((c) => Math.abs(c.y - 1500) > 300);
  return { obstacles: wall, tidal: [{ x: 2500, y: 1500, r: 450, needs: 1 }], tide };
}

/** 1.2 m until `minutes` after NOW, dry after. */
const fallsAt =
  (minutes: number, rise = 0) =>
  (t: number): number =>
    (t < NOW + minutes * MIN ? 1.2 : 0) + rise;

interface Body {
  reason?: string;
  fallback?: string;
  timing?: { departure: string; speed: number; holds: string };
  check: { legs: { status: string }[] };
}

async function planned(chart: Chart, fallback?: boolean) {
  const r = await plan(
    syntheticApi(chart),
    {
      from: at(0, 0),
      to: at(5000, 0),
      departure: NOW,
      speed: 3,
      ...(fallback !== undefined && { fallback })
    },
    NEVER,
    NOW
  );
  return { r, body: r.body as Body };
}

describe("the route passable now", () => {
  test("a bar the tide covers while the boat crosses it is passed, though it dries later in the window", async () => {
    // The boat reaches the bar about 16 minutes out; the window runs 83 minutes.
    const { r, body } = await planned(barred(fallsAt(40)));
    expect(r.status).toBe(200);
    expect(body.timing).toMatchObject({ departure: new Date(NOW).toISOString(), speed: 3 });
    expect(body.timing?.holds).toBe("now");
    expect(body.check.legs.every((l) => l.status === "ok")).toBe(true);
  });

  test("asked with fallback, the route passable at the boat's timing comes before a fallback", async () => {
    const { r, body } = await planned(barred(fallsAt(40)), true);
    expect(r.status).toBe(200);
    expect(body.fallback).toBeUndefined();
    expect(body.timing?.holds).toBe("now");
    expect(body.check.legs.every((l) => l.status === "ok")).toBe(true);
  });

  test("a fallback route, when none passes at any timing, does not hold for the trip", async () => {
    const { r, body } = await planned(barred(fallsAt(5)), true);
    expect(r.status).toBe(200);
    expect(body.fallback).toBeDefined();
    expect(body.timing?.holds).toBe("now");
  });

  test("a bar that dries before the boat gets there is refused, naming the boat's timing", async () => {
    const { r, body } = await planned(barred(fallsAt(10)));
    expect(r.status).toBe(422);
    expect(body.reason).toMatch(/at its speed from the departure/);
  });

  test("a bar dry at the departure but covered by the time the boat gets there is passed", async () => {
    const rising = (t: number): number => (t < NOW + 5 * MIN ? 0 : 1.2);
    const { r, body } = await planned(barred(rising));
    expect(r.status).toBe(200);
    // Held for the whole window: past the start the water only rises.
    expect(body.timing?.holds).toBe("trip");
  });

  test("a route that passes at any time in the window holds for the trip", async () => {
    const { r, body } = await planned(barred(() => 2));
    expect(r.status).toBe(200);
    expect(body.timing?.holds).toBe("trip");
  });

  test("more water never refuses what less water passes", async () => {
    const accepted: boolean[] = [];
    for (const rise of [0, 0.1, 0.3, 0.6, 1]) {
      accepted.push((await planned(barred(fallsAt(12, rise)))).r.status === 200);
    }
    // Once a level passes, every higher one does.
    const first = accepted.indexOf(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(accepted.slice(first).every(Boolean)).toBe(true);
  });
});

describe("arrival windows", () => {
  const timing = {
    from: at(0, 0),
    to: at(5000, 0),
    departure: NOW,
    latest: NOW,
    speed: 2,
    reach: 6000,
    slack: 0,
    whole: { start: NOW, end: NOW + 120 * MIN }
  };

  test("a square is asked about from the straight line to it until the reach less the line beyond", () => {
    const w = arrivalWindow(timing, at(2000, -10), at(2000, 10), 0);
    // 2000 m out at 2 m/s: 1000 s; at most (6000 − 3000) m by then: 1500 s.
    expect(w.start).toBeLessThanOrEqual(NOW + 1000_000);
    expect(w.start).toBeGreaterThan(NOW + 1000_000 - MIN);
    expect(w.end).toBeGreaterThanOrEqual(NOW + 1500_000);
    expect(w.end).toBeLessThanOrEqual(NOW + 1500_000 + MIN);
  });

  test("a latest departure and a slack widen the window, within the session's", () => {
    const wide = arrivalWindow(
      { ...timing, latest: NOW + 30 * MIN, slack: 0.2 },
      at(2000, -10),
      at(2000, 10),
      0
    );
    const tight = arrivalWindow(timing, at(2000, -10), at(2000, 10), 0);
    expect(wide.start).toBeLessThanOrEqual(tight.start);
    expect(wide.end).toBeGreaterThan(tight.end + 30 * MIN);
    expect(wide.end).toBeLessThanOrEqual(timing.whole.end);
  });

  test("a square past the reach is asked about the whole window, as before", () => {
    const w = arrivalWindow(timing, at(2500, 3000), at(2600, 3100), 0);
    expect(w).toEqual(timing.whole);
  });
});
