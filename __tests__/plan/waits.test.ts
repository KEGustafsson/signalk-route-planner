import type { LonLat } from "../../src/foundation/geo";
import { parsePlanRequest } from "../../src/api/plan-request";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { plan } from "../../src/plan/plan";
import { leaveTimes } from "../../src/plan/waits";
import type { PlanningApiV1 } from "../../src/oracle/contract";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, syntheticApi, xy } from "../helpers/synthetic-oracle";

/**
 * Waiting en route (plan §4.3, R3b): two bars on the way, each passable only for a short
 * while at high water, too far apart to cross both in one high water. No single departure
 * passes; waiting between them, in water with room to swing, for the next high water does.
 */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");
const HOUR = 3_600_000;

/** Banks 140 m apart from x = 2100 to x = 3900: a channel with no room to swing at anchor. */
const banks = () =>
  Array.from({ length: 19 }, (_, i) => 2100 + i * 100).flatMap((x) => [
    { x, y: 170, r: 100 },
    { x, y: -170, r: 100 }
  ]);

/** Land across x = 1500 and x = 4500, each with one gap on y = 0: a bar that needs 1.17 m. */
function twoBars(narrow = false): Chart {
  // Land north and south of each bar, 600 m apart there, closing the sea everywhere else.
  const shores = (x: number) => [
    { x, y: 8300, r: 8000 },
    { x, y: -8300, r: 8000 }
  ];
  return {
    obstacles: [...shores(1500), ...shores(4500), ...(narrow ? banks() : [])],
    tidal: [
      { x: 1500, y: 0, r: 450, needs: 1.17 },
      { x: 4500, y: 0, r: 450, needs: 1.17 }
    ],
    // High water at 09:00 and 21:00, above 1.17 m for about 50 minutes each time: two
    // 15-minute slots, and at 1.5 m/s the boat takes 33 minutes from one bar to the next.
    tide: (t) => 1.2 * Math.cos((2 * Math.PI * (t - NOW - 2 * HOUR)) / (12 * HOUR))
  };
}

interface Body {
  status: string;
  reason?: string;
  fallback?: string;
  departure?: string;
  route?: { coordinates: LonLat[] };
  check: { legs: { status: string }[]; parts: { legs: [number, number] }[] };
  gate?: {
    departure?: string;
    legs?: number[];
    reason?: string;
    waits?: { at: LonLat; place: string; arrive: string; leave: string; minutes: number }[];
  };
}

interface Over {
  latest?: number;
  waitEnRoute?: boolean;
  narrow?: boolean;
  fallback?: boolean;
  /** Charts marked not for navigation, accepted for the legs. */
  notForNavigation?: boolean;
  waitPoints?: LonLat[];
  areas?: Chart["areas"];
  api?: (a: PlanningApiV1) => PlanningApiV1;
}

async function planned(over: Over) {
  const api = syntheticApi({
    ...twoBars(over.narrow),
    notForNavigation: over.notForNavigation,
    ...(over.areas && { areas: over.areas })
  });
  const r = await plan(
    over.api ? over.api(api) : api,
    {
      from: at(0, 0),
      to: at(6000, 0),
      departure: NOW,
      speed: 1.5,
      ...(over.latest !== undefined && { latestDeparture: over.latest }),
      ...(over.waitEnRoute !== undefined && { waitEnRoute: over.waitEnRoute }),
      ...(over.waitPoints && { waitPoints: over.waitPoints }),
      ...(over.fallback !== undefined && { fallback: over.fallback }),
      ...(over.notForNavigation && { accept: ["NOT_FOR_NAVIGATION"] })
    },
    NEVER,
    NOW,
    // The fallback's search around both bars, at a trip's worth of corridor work.
    { ...DEFAULT_PLAN, maxWork: 3_000_000 }
  );
  return { r, body: r.body as Body };
}

describe("waiting en route", () => {
  test("no single departure in a day crosses both bars in one high water", async () => {
    const { r, body } = await planned({ latest: NOW + 24 * HOUR });
    expect(r.status).toBe(422);
    expect(body.gate?.reason).toMatch(/no departure up to/);
  });

  test("waiting between the bars for the next high water, the plan passes", async () => {
    const { r, body } = await planned({ latest: NOW + 24 * HOUR, waitEnRoute: true });
    expect(r.status).toBe(200);
    const waits = body.gate?.waits ?? [];
    expect(waits).toHaveLength(1);
    const w = waits[0] as NonNullable<typeof waits>[number];
    // Between the bars, clear of both, and for about one tide.
    const [x] = xy(w.at);
    expect(x).toBeGreaterThan(2000);
    expect(x).toBeLessThan(4000);
    expect(w.minutes).toBeGreaterThan(10 * 60);
    expect(w.minutes).toBeLessThan(13 * 60);
    expect(Math.round((Date.parse(w.leave) - Date.parse(w.arrive)) / 60_000)).toBe(w.minutes);
    // It leaves when the leg over the second bar starts on the slot boundary its water opens
    // at, off the grid itself, rather than at the next boundary.
    expect(Date.parse(w.leave) % (15 * 60_000)).not.toBe(0);
    // The boat leaves for the first high water and arrives at the second.
    const leave = Date.parse(body.departure as string);
    expect(leave).toBeGreaterThanOrEqual(NOW + HOUR);
    expect(leave).toBeLessThanOrEqual(NOW + 2 * HOUR);
    // The route check passes every leg, each at the time the boat sails it.
    expect(body.check.legs.every((l) => l.status === "ok")).toBe(true);
    // The wait splits the route: the part after it starts where the boat waits.
    expect(body.check.parts.length).toBeGreaterThanOrEqual(2);
    expect(body.route?.coordinates.some((p) => p[0] === w.at[0] && p[1] === w.at[1])).toBe(true);
    expect(body.gate?.legs?.length).toBeGreaterThan(0);
  });

  test("with too little time to wait for the next high water, the refusal says so", async () => {
    const { r, body } = await planned({ latest: NOW + 6 * HOUR, waitEnRoute: true });
    expect(r.status).toBe(422);
    expect(body.gate?.reason).toMatch(
      /waiting at any of the route's \d+ places with room to swing/
    );
  });

  test("between banks too close to swing at anchor, the boat may not wait, and is refused", async () => {
    const { r, body } = await planned({ latest: NOW + 24 * HOUR, waitEnRoute: true, narrow: true });
    expect(r.status).toBe(422);
    expect(body.gate?.reason).toMatch(/places with room to swing/);
  });

  test("a wait is in verified water only: water the legs may accept unverified is no place", async () => {
    const { r, body } = await planned({
      latest: NOW + 24 * HOUR,
      waitEnRoute: true,
      notForNavigation: true
    });
    expect(r.status).toBe(422);
    expect(body.gate?.reason).toMatch(/no place with room to swing/);
  });

  test("timing that stops on the planning API's error answers with the reason, never a route", async () => {
    // The wait's own session fails: the second over the timing's horizon, after the gate's.
    const horizonEnd = NOW + 24 * HOUR + (6000 / 1.5) * 1000;
    const failing = (a: PlanningApiV1): PlanningApiV1 => {
      let timing = 0;
      return {
        ...a,
        session: (params, signal, job) => {
          if (params.until > horizonEnd && params.until <= horizonEnd + 30 * 60_000) {
            timing++;
            if (timing === 2) {
              return Promise.resolve({ ok: false, status: 503, error: "the index is rebuilding" });
            }
          }
          return a.session(params, signal, job);
        }
      };
    };
    // With fallback, the plan without waits offers the fallback's marked route.
    const { r, body } = await planned({
      latest: NOW + 24 * HOUR,
      waitEnRoute: true,
      fallback: true,
      api: failing
    });
    expect(r.status).toBe(422);
    expect(body.route).toBeUndefined();
    expect(body.reason).toBe("the index is rebuilding");
  });

  test("a wait may end on the boundary a leg ahead opens at, or just past it", () => {
    const SLOT = 15 * 60_000;
    // A gated leg 5 minutes ahead of the place: leave 10 minutes past a boundary to start it on
    // the next one, and 1 ms later to start it past it whatever the sums of sailing times do.
    const t = leaveTimes(0, 2 * SLOT, 0, [5 * 60_000]);
    expect(t).toEqual([10 * 60_000, 10 * 60_000 + 1, 25 * 60_000, 25 * 60_000 + 1]);
    // The place's own leg (no sailing ahead) on the boundaries alone.
    expect(leaveTimes(0, 2 * SLOT, 0, [0])).toEqual([SLOT, 2 * SLOT]);
  });

  test("waitEnRoute is a boolean and needs a latest departure", () => {
    const base = { from: [22, 60], to: [22.1, 60.1], departure: new Date(NOW).toISOString() };
    const latest = new Date(NOW + 6 * HOUR).toISOString();
    expect(parsePlanRequest({ ...base, waitEnRoute: true }, NOW).ok).toBe(false);
    expect(parsePlanRequest({ ...base, latestDeparture: latest, waitEnRoute: "yes" }, NOW).ok).toBe(
      false
    );
    const ok = parsePlanRequest({ ...base, latestDeparture: latest, waitEnRoute: true }, NOW);
    expect(ok.ok && ok.value.waitEnRoute).toBe(true);
  });
});

/** A square ring `h` metres about (x, y), closed. */
const square = (x: number, y: number, h: number): [number, number][] => [
  [x - h, y - h],
  [x + h, y - h],
  [x + h, y + h],
  [x - h, y + h],
  [x - h, y - h]
];

const DAY = { latest: NOW + 24 * HOUR, waitEnRoute: true };

/** Whether every gated leg the reply names crosses a bar. */
function gatedCrossBars(body: Body): boolean {
  const route = body.route?.coordinates ?? [];
  return (body.gate?.legs ?? []).every((k) => {
    const [ax] = xy(route[k] as LonLat);
    const [bx] = xy(route[k + 1] as LonLat);
    return [1500, 4500].some(
      (bar) => Math.min(ax, bx) <= bar + 450 && Math.max(ax, bx) >= bar - 450
    );
  });
}

describe("waiting at anchorages and the user's points", () => {
  test("a waiting point off the route is reached by a detour and waited at", async () => {
    const point = at(3000, 300);
    const { r, body } = await planned({ ...DAY, waitPoints: [point] });
    expect(r.status).toBe(200);
    const waits = body.gate?.waits ?? [];
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ at: point, place: "user" });
    // Out to the point and back: the route meets the route point it left from twice.
    const route = body.route?.coordinates ?? [];
    const k = route.findIndex((q) => q[0] === point[0] && q[1] === point[1]);
    expect(k).toBeGreaterThan(0);
    expect(route[k - 1]).toEqual(route[k + 1]);
    expect(body.check.legs.every((l) => l.status === "ok")).toBe(true);
    expect(body.gate?.legs?.length).toBeGreaterThan(0);
    expect(gatedCrossBars(body)).toBe(true);
  });

  test("a charted anchorage off the route is waited at, at its centre", async () => {
    const { r, body } = await planned({
      ...DAY,
      areas: [{ class: "ACHARE", ring: square(3000, 250, 60) }]
    });
    expect(r.status).toBe(200);
    const w = body.gate?.waits?.[0];
    expect(w?.place).toBe("anchorage");
    const [x, y] = xy(w?.at as LonLat);
    expect(Math.abs(x - 3000)).toBeLessThan(1);
    expect(Math.abs(y - 250)).toBeLessThan(1);
    expect(body.check.legs.every((l) => l.status === "ok")).toBe(true);
    expect(gatedCrossBars(body)).toBe(true);
  });

  test("an anchorage the route crosses is waited at on the route", async () => {
    const { r, body } = await planned({
      ...DAY,
      areas: [{ class: "ACHARE", ring: square(3000, 0, 300) }]
    });
    expect(r.status).toBe(200);
    const w = body.gate?.waits?.[0];
    expect(w?.place).toBe("anchorage");
    const [x, y] = xy(w?.at as LonLat);
    // In the area, at one of the route's own points: no detour.
    expect(Math.abs(x - 3000)).toBeLessThanOrEqual(300);
    expect(Math.abs(y)).toBeLessThanOrEqual(300);
    expect(body.check.legs.every((l) => l.status === "ok")).toBe(true);
    const route = body.route?.coordinates ?? [];
    const k = route.findIndex((q) => q[0] === w?.at[0] && q[1] === w.at[1]);
    expect(k).toBeGreaterThan(0);
    expect(route[k - 1]).not.toEqual(route[k + 1]);
  });

  test("an area where anchoring is prohibited is no place: the route's own places serve", async () => {
    const { r, body } = await planned({
      ...DAY,
      areas: [{ class: "ACHARE", ring: square(3000, 250, 60), restrictions: [1] }]
    });
    expect(r.status).toBe(200);
    expect(body.gate?.waits?.[0]?.place).toBe("route");
  });

  test("a waiting point out of reach is left out, and the route's own places serve", async () => {
    const { r, body } = await planned({ ...DAY, waitPoints: [at(3000, -2500)] });
    expect(r.status).toBe(200);
    expect(body.gate?.waits?.[0]?.place).toBe("route");
  });

  test("waitPoints needs waitEnRoute and at most ten positions", () => {
    const base = { from: [22, 60], to: [22.1, 60.1], latestDeparture: "2026-11-18T12:00:00Z" };
    const now = NOW;
    expect(parsePlanRequest({ ...base, waitPoints: [[22, 60]] }, now).ok).toBe(false);
    const ok = parsePlanRequest({ ...base, waitEnRoute: true, waitPoints: [[22.05, 60.05]] }, now);
    expect(ok.ok && ok.value.waitPoints).toEqual([[22.05, 60.05]]);
    const many = Array.from({ length: 11 }, () => [22, 60]);
    expect(parsePlanRequest({ ...base, waitEnRoute: true, waitPoints: many }, now).ok).toBe(false);
    expect(parsePlanRequest({ ...base, waitEnRoute: true, waitPoints: [[200, 0]] }, now).ok).toBe(
      false
    );
  });
});
