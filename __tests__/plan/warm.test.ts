import type { PlanningApiV1, Prepared, PrepareResult } from "../../src/oracle/contract";
import { PLANNING_API } from "../../src/oracle/contract";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { Preparer } from "../../src/plan/prepare";
import { warmed } from "../../src/plan/warm";
import { apiFor } from "../../src/plugin-api";
import type { Synthetic } from "../helpers/synthetic-oracle";
import { at, syntheticApi } from "../helpers/synthetic-oracle";

/**
 * An index asked for ahead of its plan (`plan/warm.ts`, `POST /prepare`): the build a plan would
 * wait for is started and answered at once, and the plan that follows waits for the same build.
 */

const g = globalThis as unknown as Record<symbol, unknown>;
const NOW = Date.parse("2026-11-18T07:00:00Z");
const NEVER = new AbortController().signal;
const flush = () => new Promise((r) => setImmediate(r));

/** A provider that prepares when `settle` says so, with the regions asked of it. */
function preparing(inner: Synthetic) {
  const calls: number[][] = [];
  let settle: (r: PrepareResult) => void = () => undefined;
  const prepared: Prepared = {
    coverage: [21, 59, 23, 61],
    session: (p, s, job) => inner.session(p, s, job),
    routeCheck: (b, s) => inner.routeCheck(b, s),
    release: () => undefined
  };
  const api: PlanningApiV1 = {
    ...inner,
    features: ["prepare"],
    prepare: (region) => {
      calls.push(region);
      return new Promise((resolve) => {
        settle = resolve;
      });
    }
  };
  return { api, calls, settle: (r?: PrepareResult) => settle(r ?? { ok: true, value: prepared }) };
}

const TRIP = { from: at(0, 0), to: at(5000, 0) };

afterEach(() => {
  delete g[PLANNING_API];
});

describe("an index asked for ahead of its plan", () => {
  test("202 preparing at once while it is built; the plan that follows waits for that build", async () => {
    const p = preparing(syntheticApi({ obstacles: [{ x: 2500, y: 0, r: 600 }] }));
    g[PLANNING_API] = p.api;
    const api = apiFor({ now: () => NOW }, () => NEVER, new Preparer(60_000));
    const ahead = await api.prepare(TRIP);
    expect(ahead).toEqual({ status: 202, body: { state: "preparing" } });
    expect(p.calls).toHaveLength(1);
    const plan = api.plan(TRIP, NEVER);
    await flush();
    // The plan asked for no build of its own.
    expect(p.calls).toHaveLength(1);
    p.settle();
    await flush();
    // Built: the provider holds it, and gives it to the plan's own request.
    p.settle();
    const r = await plan;
    expect(r.status).toBe(200);
  });

  test("200 ready when the provider gives an index within the wait", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    const found = {
      ...p.api,
      prepare: () => Promise.resolve({ ok: true as const, value: {} as Prepared })
    };
    const r = await warmed(found, TRIP, NEVER, new Preparer(60_000), DEFAULT_PLAN);
    expect(r).toEqual({ status: 200, body: { state: "ready" } });
  });

  test("a provider that prepares nothing is ready as it is, with nothing asked of it", async () => {
    const inner = syntheticApi({ obstacles: [] });
    const r = await warmed(inner, TRIP, NEVER, new Preparer(60_000), DEFAULT_PLAN);
    expect(r).toEqual({ status: 200, body: { state: "ready" } });
  });

  test("while one index is built none is asked for another trip", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    const preparer = new Preparer(60_000);
    await warmed(p.api, TRIP, NEVER, preparer, DEFAULT_PLAN, 5);
    const other = { from: at(0, 20_000), to: at(5000, 20_000) };
    const r = await warmed(p.api, other, NEVER, preparer, DEFAULT_PLAN, 5);
    expect(r).toEqual({ status: 202, body: { state: "preparing" } });
    expect(p.calls).toHaveLength(1);
    // Once it is built the next is asked for.
    p.settle();
    await flush();
    await warmed(p.api, other, NEVER, preparer, DEFAULT_PLAN, 5);
    expect(p.calls).toHaveLength(2);
  });

  test("a trip no plan asks an index for starts nothing: one point, or past maxDistance", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    const surveying = { ...p.api, features: ["prepare", "survey", "corridor"] };
    const preparer = new Preparer(60_000);
    for (const trip of [
      { from: at(0, 0), to: at(0, 0) },
      { from: at(0, 0), to: at(DEFAULT_PLAN.maxDistance + 1000, 0) }
    ]) {
      const r = await warmed(surveying, trip, NEVER, preparer, DEFAULT_PLAN, 5);
      expect(r).toEqual({ status: 200, body: { state: "none" } });
    }
    expect(p.calls).toHaveLength(0);
  });

  test("the provider's refusal is the answer: a region too large is 413", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    const refusing = {
      ...p.api,
      prepare: () => Promise.resolve({ ok: false as const, status: 413, error: "too large" })
    };
    const r = await warmed(refusing, TRIP, NEVER, new Preparer(60_000), DEFAULT_PLAN);
    expect(r.status).toBe(413);
  });

  test("a body no plan takes is 400, a plugin not started 503, and neither starts a build", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    g[PLANNING_API] = p.api;
    const api = apiFor({ now: () => NOW }, () => NEVER, new Preparer(60_000));
    expect((await api.prepare({ from: [200, 0], to: at(5000, 0) })).status).toBe(400);
    const stopped = apiFor({ now: () => NOW }, () => undefined, new Preparer(60_000));
    expect((await stopped.prepare(TRIP)).status).toBe(503);
    delete g[PLANNING_API];
    expect((await api.prepare(TRIP)).status).toBe(503);
    expect(p.calls).toHaveLength(0);
  });
});
