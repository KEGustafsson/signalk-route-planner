import type { LonLat } from "../../src/foundation/geo";
import { parsePlanRequest } from "../../src/api/plan-request";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { plan } from "../../src/plan/plan";
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
  departure?: string;
  route: { coordinates: LonLat[] };
  check: { legs: { status: string }[]; parts: { legs: [number, number] }[] };
  gate?: {
    departure?: string;
    legs?: number[];
    reason?: string;
    waits?: { at: LonLat; arrive: string; leave: string; minutes: number }[];
  };
}

async function planned(over: { latest?: number; waitEnRoute?: boolean; narrow?: boolean }) {
  const r = await plan(
    syntheticApi(twoBars(over.narrow)),
    {
      from: at(0, 0),
      to: at(6000, 0),
      departure: NOW,
      speed: 1.5,
      ...(over.latest !== undefined && { latestDeparture: over.latest }),
      ...(over.waitEnRoute !== undefined && { waitEnRoute: over.waitEnRoute })
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
    // The boat leaves for the first high water and arrives at the second.
    const leave = Date.parse(body.departure as string);
    expect(leave).toBeGreaterThanOrEqual(NOW + HOUR);
    expect(leave).toBeLessThanOrEqual(NOW + 2 * HOUR);
    // The route check passes every leg, each at the time the boat sails it.
    expect(body.check.legs.every((l) => l.status === "ok")).toBe(true);
    // The wait splits the route: the part after it starts where the boat waits.
    expect(body.check.parts.length).toBeGreaterThanOrEqual(2);
    expect(body.route.coordinates.some((p) => p[0] === w.at[0] && p[1] === w.at[1])).toBe(true);
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
