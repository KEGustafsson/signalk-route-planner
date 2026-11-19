import { plan } from "../../src/plan/plan";
import { at, syntheticApi } from "../helpers/synthetic-oracle";

/** A plan's statuses come from the route check of its final route (AGENTS.md invariant 1). */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");
const ISLAND = { obstacles: [{ x: 2500, y: 0, r: 600 }] };

describe("plan", () => {
  test("the reply's statuses are the route check's, at the request's departure", async () => {
    const api = syntheticApi(ISLAND);
    const bodies: unknown[] = [];
    const check = api.routeCheck.bind(api);
    api.routeCheck = (body, signal) => {
      bodies.push(body);
      return check(body, signal);
    };
    const r = await plan(
      api,
      { from: at(0, 0), to: at(5000, 0), departure: NOW, speed: 3, draft: 1.9 },
      NEVER,
      NOW
    );
    expect(r.status).toBe(200);
    const body = r.body as {
      status: string;
      check: { legs: { status: string }[] };
      direct: { status: string };
    };
    expect(body.status).toBe("ok");
    expect(body.direct.status).toBe("fail");
    expect(body.check.legs.every((l) => l.status === "ok")).toBe(true);
    expect(bodies[0]).toMatchObject({
      departure: "2026-11-18T07:00:00.000Z",
      speed: 3,
      vessel: { draft: 1.9 }
    });
    // The verdicts hold from departure over three times the straight trip (5 km at 3 m/s), at least 1 h.
    const until = (api.sessions[0]?.until ?? 0) - NOW;
    expect(api.sessions[0]?.departure).toBe(NOW);
    expect(Math.abs(until - 5_000_000)).toBeLessThan(5000);
  });

  test("a route check that marks a leg marginal makes the plan marginal", async () => {
    const api = syntheticApi(ISLAND, {
      routeCheck: (body) => {
        const coords = (body as { route: { coordinates: unknown[] } }).route.coordinates;
        const legs = coords
          .slice(1)
          .map((_, i) => ({ index: i, status: i === 0 ? "marginal" : "ok", length: 100 }));
        return Promise.resolve({ status: 200, body: { legs } });
      }
    });
    const r = await plan(
      api,
      { from: at(0, 0), to: at(5000, 0), departure: NOW, speed: 3 },
      NEVER,
      NOW
    );
    expect((r.body as { status: string }).status).toBe("marginal");
  });

  test.each([
    ["fail", 0.9, []],
    ["unverified", 0, ["NO_COVERAGE"]]
  ])(
    "a final route check with a %s leg refuses the strict plan with the legs",
    async (status, risk, flags) => {
      const api = syntheticApi(ISLAND, {
        routeCheck: (body) => {
          const coords = (body as { route: { coordinates: unknown[] } }).route.coordinates;
          const legs = coords.slice(1).map((_, i) => ({
            index: i,
            ...(i === 0 ? { status, risk, flags } : { status: "ok", risk: 0, flags: [] }),
            length: 100
          }));
          return Promise.resolve({ status: 200, body: { legs } });
        }
      });
      const r = await plan(
        api,
        { from: at(0, 0), to: at(5000, 0), departure: NOW, speed: 3 },
        NEVER,
        NOW
      );
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({
        reason: expect.stringMatching(/does not pass 1 of the \d+ planned legs/),
        check: { legs: expect.arrayContaining([expect.objectContaining({ status })]) }
      });
      expect(r.body).not.toHaveProperty("route");
    }
  );

  test("no route: 422 with the reason and the direct line's verdict", async () => {
    const ring = Array.from({ length: 48 }, (_, i) => {
      const t = (i / 48) * 2 * Math.PI;
      return { x: 5000 + 1500 * Math.cos(t), y: 1500 * Math.sin(t), r: 150 };
    });
    const r = await plan(
      syntheticApi({ obstacles: ring }),
      { from: at(0, 0), to: at(5000, 0), departure: NOW, speed: 3 },
      NEVER,
      NOW
    );
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ direct: { status: "fail" }, reason: expect.any(String) });
    expect(r.body).not.toHaveProperty("route");
  });

  test("too far apart, the same point, or a session refused: never a route", async () => {
    const api = syntheticApi({ obstacles: [] });
    const far = await plan(
      api,
      { from: at(0, 0), to: at(70000, 0), departure: NOW, speed: 3 },
      NEVER,
      NOW
    );
    expect(far.status).toBe(400);
    const same = await plan(
      api,
      { from: at(0, 0), to: at(0, 0), departure: NOW, speed: 3 },
      NEVER,
      NOW
    );
    expect(same.status).toBe(400);
    const busy = syntheticApi(
      { obstacles: [] },
      { session: () => Promise.resolve({ ok: false, status: 503, error: "busy" }) }
    );
    const r = await plan(
      busy,
      { from: at(0, 0), to: at(5000, 0), departure: NOW, speed: 3 },
      NEVER,
      NOW
    );
    expect(r).toEqual({ status: 503, body: { errors: ["busy"] } });
  });

  test("a route check that fails is passed on, not turned into a route", async () => {
    const api = syntheticApi(ISLAND, {
      routeCheck: () =>
        Promise.resolve({ status: 503, body: { errors: ["no chart index loaded"] } })
    });
    const r = await plan(
      api,
      { from: at(0, 0), to: at(5000, 0), departure: NOW, speed: 3 },
      NEVER,
      NOW
    );
    expect(r.status).toBe(503);
  });
});

describe("charts not for navigation", () => {
  const chart = { obstacles: [{ x: 2500, y: 0, r: 600 }], notForNavigation: true };

  test("refused unless the request accepts them, so the planner is never silently lax", async () => {
    const r = await plan(
      syntheticApi(chart),
      { from: at(0, 0), to: at(5000, 0), departure: NOW, speed: 3 },
      NEVER,
      NOW
    );
    expect(r.status).toBe(422);
  });

  test("accepted: a route round the island, every leg unverified, never ok", async () => {
    const r = await plan(
      syntheticApi(chart),
      { from: at(0, 0), to: at(5000, 0), departure: NOW, speed: 3, accept: ["NOT_FOR_NAVIGATION"] },
      NEVER,
      NOW
    );
    expect(r.status).toBe(200);
    const body = r.body as {
      status: string;
      accepted: string[];
      check: { legs: { status: string }[] };
    };
    expect(body.status).toBe("unverified");
    expect(body.accepted).toEqual(["NOT_FOR_NAVIGATION"]);
    expect(body.check.legs.every((l) => l.status === "unverified")).toBe(true);
  });
});
