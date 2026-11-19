import type { PlanningApiV1, Prepared, PrepareResult } from "../../src/oracle/contract";
import { canPrepare, PLANNING_API } from "../../src/oracle/contract";
import { BUILDING, onPrepared, PREPARE_MARGIN, Preparer, tripRegion } from "../../src/plan/prepare";
import { apiFor } from "../../src/plugin-api";
import type { Synthetic } from "../helpers/synthetic-oracle";
import { at, syntheticApi } from "../helpers/synthetic-oracle";

/** Charts for a trip past the chart box (plan §4.2, R2): signalk-underkeel's prepare. */

const NOW = Date.parse("2026-11-19T07:00:00Z");
const g = globalThis as unknown as Record<symbol, unknown>;

/** A provider with `prepare` resolving through `settle`; its index is `inner`'s. */
function preparing(
  inner: Synthetic,
  coverage = [21, 59, 23, 61] as [number, number, number, number]
) {
  const calls: { region: number[]; signal: AbortSignal }[] = [];
  let settle: (r: PrepareResult) => void = () => undefined;
  const prepared: Prepared = {
    coverage,
    session: (p, s, job) => inner.session(p, s, job),
    routeCheck: (b, s) => inner.routeCheck(b, s),
    release: () => undefined
  };
  const api: PlanningApiV1 = {
    ...inner,
    features: ["prepare"],
    prepare: (region, signal) => {
      calls.push({ region, signal });
      return new Promise((resolve) => {
        settle = resolve;
      });
    }
  };
  return {
    api,
    calls,
    prepared,
    settle: (r?: PrepareResult) => settle(r ?? { ok: true, value: prepared })
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("tripRegion", () => {
  test("the box of both ends grown by the margin on every side", () => {
    const [w, s, e, n] = tripRegion([22, 60], [22.5, 60.2]);
    const dLat = PREPARE_MARGIN / 111195;
    expect(s).toBeCloseTo(60 - dLat, 5);
    expect(n).toBeCloseTo(60.2 + dLat, 5);
    // Wider in longitude, by the cosine of the poleward edge.
    expect(22 - w).toBeCloseTo(dLat / Math.cos((n * Math.PI) / 180), 5);
    expect(e - 22.5).toBeCloseTo(22 - w, 9);
    expect(tripRegion([0, 84.9], [1, 84.99])[3]).toBe(85);
  });
});

describe("Preparer", () => {
  test("a provider without prepare is used as it is", async () => {
    const api = syntheticApi({ obstacles: [] });
    expect(canPrepare(api)).toBe(false);
    expect(
      await new Preparer(10).forTrip(api, at(0, 0), at(5000, 0), new AbortController().signal)
    ).toBe(api);
  });

  test("plans on the prepared index once it is built, the build carried on past a request that gave up", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    const prep = new Preparer(5);
    const stop = new AbortController().signal;
    const first = await prep.forTrip(p.api, at(0, 0), at(5000, 0), stop);
    expect(first).toBe(BUILDING);
    expect(p.calls).toHaveLength(1);
    // The build runs until the plugin stops, not the request.
    expect(p.calls[0]?.signal).toBe(stop);
    // Asked again while it builds: the same build, not a second.
    const second = prep.forTrip(p.api, at(0, 0), at(5000, 0), stop);
    p.settle();
    const got = await second;
    expect(p.calls).toHaveLength(1);
    expect("version" in got && got.coverage()).toEqual([21, 59, 23, 61]);
  });

  test("a refusal is the reply: 413 for a region too large", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    const prep = new Preparer(1000);
    const r = prep.forTrip(p.api, at(0, 0), at(5000, 0), new AbortController().signal);
    await flush();
    p.settle({ ok: false, status: 413, error: "too large" });
    expect(await r).toEqual({ status: 413, body: { errors: ["too large"] } });
  });

  test("the prepared index serves the sessions and the route check", async () => {
    const inner = syntheticApi({ obstacles: [] });
    const p = preparing(inner);
    const on = onPrepared(p.api, p.prepared);
    const r = await on.session(
      { departure: NOW, until: NOW + 1000, speed: 3 },
      new AbortController().signal,
      async () => 7
    );
    expect(r).toEqual({ ok: true, value: 7 });
    expect(inner.sessions).toHaveLength(1);
    expect(on.defaults()).toEqual(inner.defaults());
  });
});

describe("/plan with prepare", () => {
  afterEach(() => {
    delete g[PLANNING_API];
  });

  test("503 with Retry-After while the trip's index builds, then the plan on it", async () => {
    const p = preparing(syntheticApi({ obstacles: [{ x: 2500, y: 0, r: 600 }] }));
    g[PLANNING_API] = p.api;
    const api = apiFor({ now: () => NOW }, () => new AbortController().signal, new Preparer(5));
    const body = { from: at(0, 0), to: at(5000, 0) };
    const waiting = await api.plan(body, new AbortController().signal);
    expect(waiting).toMatchObject({
      status: 503,
      headers: { "Retry-After": "30" },
      body: { preparing: true }
    });
    p.settle();
    await flush();
    // Built: underkeel holds it, and prepare answers at once.
    const again = api.plan(body, new AbortController().signal);
    await flush();
    p.settle();
    const r = await again;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ok" });
  });

  test("a trip too long to plan builds nothing", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    g[PLANNING_API] = p.api;
    const api = apiFor({ now: () => NOW }, () => new AbortController().signal, new Preparer(5));
    const r = await api.plan({ from: at(0, 0), to: at(70_000, 0) }, new AbortController().signal);
    expect(r.status).toBe(400);
    expect(p.calls).toHaveLength(0);
  });
});
