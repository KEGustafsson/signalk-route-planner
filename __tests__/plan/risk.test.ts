import { parsePlanRequest } from "../../src/api/plan-request";
import type { LonLat } from "../../src/foundation/geo";
import { plan } from "../../src/plan/plan";
import { listing, reasonOf, routeRisk } from "../../src/plan/risk";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, syntheticApi, xy } from "../helpers/synthetic-oracle";

/**
 * Risk cost, budget and alternatives (plan §4.4): water the check passes near the margin lies
 * across the direct line. The shortest route crosses it; with a risk cost the route keeps
 * clear of it, longer and at less risk.
 */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");

/** A shoal the check passes at P = 0.008, under the accepted 0.01, across the direct line. */
const chart: Chart = {
  obstacles: [],
  risky: [{ x: 2000, y: 0, r: 300, risk: 0.008 }]
};

interface Listed {
  name: string;
  riskWeight: number;
  length?: number;
  risk?: number;
  status?: string;
  reason?: string;
  sameAs?: string;
  route?: { coordinates: LonLat[] };
}

interface Body {
  reason?: string;
  risk?: number;
  length?: number;
  riskWeight?: number;
  chosen?: string;
  route?: { coordinates: LonLat[] };
  alternatives?: Listed[];
  check?: { legs: { status: string }[] };
}

/** A wide shoal at P = 0.002 about the same one: the balanced route crosses only its edge. */
const graded: Chart = {
  obstacles: [],
  risky: [{ x: 2000, y: 0, r: 1200, risk: 0.002 }, ...(chart.risky ?? [])]
};

async function planned(over: Record<string, unknown>, on: Chart = chart) {
  const r = await plan(
    syntheticApi(on),
    { from: at(0, 0), to: at(4000, 0), departure: NOW, speed: 3, ...over },
    NEVER,
    NOW
  );
  return { r, body: r.body as Body };
}

/** How near the route's legs come to the shoal's centre, metres. */
function clearance(route: LonLat[]): number {
  let near = Infinity;
  for (let i = 1; i < route.length; i++) {
    const [ax, ay] = xy(route[i - 1] as LonLat);
    const [bx, by] = xy(route[i] as LonLat);
    for (let k = 0; k <= 100; k++) {
      const x = ax + ((bx - ax) * k) / 100;
      const y = ay + ((by - ay) * k) / 100;
      near = Math.min(near, Math.hypot(x - 2000, y));
    }
  }
  return near;
}

describe("risk cost", () => {
  test("the shortest route crosses water near the margin, and states its risk", async () => {
    const { r, body } = await planned({});
    expect(r.status).toBe(200);
    expect(body.route?.coordinates).toHaveLength(2);
    expect(body.risk).toBeCloseTo(0.008, 6);
    expect(body.riskWeight).toBe(0);
  });

  test("with a risk weight the route keeps clear of it, longer and at less risk", async () => {
    const shortest = await planned({});
    const { r, body } = await planned({ riskWeight: 10 });
    expect(r.status).toBe(200);
    expect(body.riskWeight).toBe(10);
    expect(body.risk).toBe(0);
    expect(body.length).toBeGreaterThan(shortest.body.length as number);
    // Clear of the shoal by its radius and the corridor half-width.
    expect(clearance(body.route?.coordinates ?? [])).toBeGreaterThan(300 + 40 - 1);
    expect(body.check?.legs.every((l) => l.status === "ok")).toBe(true);
  });

  test("a route over the risk budget is refused, and says so", async () => {
    const { r, body } = await planned({ riskBudget: 0.005 });
    expect(r.status).toBe(422);
    expect(body.reason).toMatch(/the route's risk, 0\.00800, is over the budget of 0\.005/);
  });

  test("the route's risk is the chance that any leg has UKC < 0", () => {
    expect(routeRisk([])).toBe(0);
    expect(routeRisk([{ risk: 0.1 }, { risk: 0.1 }])).toBeCloseTo(0.19, 12);
    // One risky leg's own probability, exactly; a tiny one is kept, not rounded to 0.
    expect(routeRisk([{ risk: 0 }, { risk: 0.0099 }, { risk: 0 }])).toBe(0.0099);
    expect(routeRisk([{ risk: 1e-20 }, { risk: 1e-20 }])).toBeCloseTo(2e-20, 30);
    expect(routeRisk([{ risk: 1 }, { risk: 0.2 }])).toBe(1);
  });

  test("a route whose risk equals the budget is offered", async () => {
    const { r, body } = await planned({ riskBudget: 0.008 });
    expect(r.status).toBe(200);
    expect(body.risk).toBe(0.008);
  });

  test("a refusal without a body gives the general reason", () => {
    expect(reasonOf({ status: 503, body: null })).toBe("the route check does not pass the route");
    expect(reasonOf({ status: 422, body: { reason: 7 } })).toBe(
      "the route check does not pass the route"
    );
    expect(reasonOf({ status: 422, body: { reason: "closed" } })).toBe("closed");
  });
});

describe("alternatives", () => {
  test("each alternative states its length and risk; the shortest is offered first", async () => {
    const { r, body } = await planned({ alternatives: true }, graded);
    expect(r.status).toBe(200);
    expect(body.chosen).toBe("shortest");
    const listed = body.alternatives ?? [];
    expect(listed.map((a) => a.name)).toEqual(["shortest", "balanced", "safest"]);
    for (const a of listed) {
      expect(a.length).toBeGreaterThan(0);
      expect(typeof a.risk).toBe("number");
      expect(a.status).toBe("ok");
    }
    // Each weight trades length for risk: shorter is riskier.
    const [shortest, balanced, safest] = listed as [Listed, Listed, Listed];
    expect(shortest.risk).toBeGreaterThan(balanced.risk as number);
    expect(balanced.risk).toBeGreaterThan(safest.risk as number);
    expect(shortest.length).toBeLessThan(balanced.length as number);
    expect(balanced.length).toBeLessThan(safest.length as number);
    expect(listed.some((a) => a.sameAs !== undefined)).toBe(false);
    // The reply is the chosen route itself.
    expect(body.route).toEqual(shortest.route);
  });

  test("with a risk budget, the first alternative within it is offered", async () => {
    const { r, body } = await planned({ alternatives: true, riskBudget: 0.005 });
    expect(r.status).toBe(200);
    expect(body.chosen).not.toBe("shortest");
    expect(body.risk).toBeLessThanOrEqual(0.005);
    const shortest = body.alternatives?.[0];
    expect(shortest?.reason).toMatch(/over the budget/);
  });

  test("an alternative with the same route as an earlier one says so", async () => {
    // One small shoal: the balanced weight already keeps clear of it, as the safest does.
    const { body } = await planned({ alternatives: true });
    const [, balanced, safest] = body.alternatives as [Listed, Listed, Listed];
    expect(balanced.risk).toBe(0);
    expect(safest.route).toEqual(balanced.route);
    expect(safest.sameAs).toBe("balanced");
    expect(balanced.sameAs).toBeUndefined();
  });
});

describe("risk options in the request", () => {
  const base = { from: [22, 60], to: [22.1, 60.1] };

  test("riskWeight is 0..100 and riskBudget over 0 up to 1", () => {
    expect(parsePlanRequest({ ...base, riskWeight: -1 }, NOW).ok).toBe(false);
    expect(parsePlanRequest({ ...base, riskWeight: 101 }, NOW).ok).toBe(false);
    expect(parsePlanRequest({ ...base, riskBudget: 0 }, NOW).ok).toBe(false);
    expect(parsePlanRequest({ ...base, riskBudget: 1.5 }, NOW).ok).toBe(false);
    const ok = parsePlanRequest({ ...base, riskWeight: 2, riskBudget: 0.01 }, NOW);
    expect(ok.ok && ok.value).toMatchObject({ riskWeight: 2, riskBudget: 0.01 });
  });

  test("alternatives is a boolean, not with a riskWeight or a latest departure", () => {
    expect(parsePlanRequest({ ...base, alternatives: "yes" }, NOW).ok).toBe(false);
    expect(parsePlanRequest({ ...base, alternatives: true, riskWeight: 2 }, NOW).ok).toBe(false);
    const latest = new Date(NOW + 3_600_000).toISOString();
    expect(
      parsePlanRequest(
        {
          ...base,
          departure: new Date(NOW).toISOString(),
          latestDeparture: latest,
          alternatives: true
        },
        NOW
      ).ok
    ).toBe(false);
    const ok = parsePlanRequest({ ...base, alternatives: true }, NOW);
    expect(ok.ok && ok.value.alternatives).toBe(true);
  });
});

describe("listing alternatives", () => {
  const offered = (length: number, risk: number, at: number) => ({
    status: 200,
    body: {
      route: {
        coordinates: [
          [0, 0],
          [at, 1]
        ]
      },
      length,
      risk,
      status: "ok",
      check: { legs: [{ index: 0, status: "ok", risk, length, flags: [], part: "route" }] }
    }
  });

  test("a larger weight that bought no less risk is dominated by the earlier route", () => {
    const shortest = { name: "shortest", reply: offered(1000, 0.02, 1) };
    const safest = { name: "safest", reply: offered(1100, 0.03, 2) };
    const listed = listing("safest", 10, safest.reply, [shortest, safest]) as Record<
      string,
      unknown
    >;
    expect(listed.dominatedBy).toBe("shortest");
    expect(listed.sameAs).toBeUndefined();
  });

  test("a longer route at less risk is not dominated", () => {
    const shortest = { name: "shortest", reply: offered(1000, 0.02, 1) };
    const balanced = { name: "balanced", reply: offered(1100, 0.01, 2) };
    const listed = listing("balanced", 2, balanced.reply, [shortest, balanced]) as Record<
      string,
      unknown
    >;
    expect(listed.dominatedBy).toBeUndefined();
    expect(listed.legs).toEqual([{ status: "ok", risk: 0.01, length: 1100 }]);
  });
});
