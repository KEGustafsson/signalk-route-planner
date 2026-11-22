import type { PlanningApiV1, Prepared, PrepareResult } from "../../src/oracle/contract";
import { canPrepare, PLANNING_API } from "../../src/oracle/contract";
import {
  BUILDING,
  onPrepared,
  PREPARE_MARGIN,
  Preparer,
  searchRegion,
  tripLimits,
  tripRegion
} from "../../src/plan/prepare";
import { boxReleased, apiFor } from "../../src/plugin-api";
import { DEFAULT_PLAN } from "../../src/plan/options";
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

const holds = (o: number[], i: number[]) =>
  (o[0] as number) <= (i[0] as number) &&
  (o[1] as number) <= (i[1] as number) &&
  (o[2] as number) >= (i[2] as number) &&
  (o[3] as number) >= (i[3] as number);

describe("searchRegion", () => {
  test("holds the trip's least region, and for a long trip the search's wider square", () => {
    const short = [at(0, 0), at(1000, 0)] as const;
    expect(holds(tripRegion(...short), searchRegion(...short))).toBe(true);
    const long = [at(0, 0), at(20_000, 0)] as const;
    const whole = searchRegion(...long);
    expect(holds(whole, tripRegion(...long))).toBe(true);
    // The search reaches d/2 + max(d/2, minMargin) from the midpoint: 20 km north and south.
    expect(holds(whole, tripRegion(at(10_000, 19_000), at(10_000, -19_000), 0))).toBe(true);
  });
});

describe("Preparer", () => {
  test("asks for the whole search region, then the least when that is too large to build", async () => {
    const asked: number[][] = [];
    const inner = syntheticApi({ obstacles: [] });
    const api: PlanningApiV1 = {
      ...inner,
      features: ["prepare"],
      prepare: (region) => {
        asked.push(region);
        return Promise.resolve(
          asked.length === 1
            ? { ok: false, status: 413, error: "too large" }
            : { ok: false, status: 503, error: "no cells" }
        );
      }
    };
    const from = at(0, 0);
    const to = at(20_000, 0);
    const r = await new Preparer(1000).forTrip(api, from, to, new AbortController().signal);
    expect(asked).toEqual([searchRegion(from, to), tripRegion(from, to)]);
    expect(r).toEqual({ status: 503, body: { errors: ["no cells"] } });
  });

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

  test("a refusal is the reply: 413 when even the least region is too large", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    const prep = new Preparer(1000);
    const r = prep.forTrip(p.api, at(0, 0), at(5000, 0), new AbortController().signal);
    await flush();
    p.settle({ ok: false, status: 413, error: "too large" });
    await flush();
    p.settle({ ok: false, status: 413, error: "still too large" });
    expect(await r).toEqual({ status: 413, body: { errors: ["still too large"] } });
    expect(p.calls).toHaveLength(2);
  });

  /** A provider whose every `prepare` call is settled on its own. */
  function each() {
    const calls: { region: number[]; settle: (r: PrepareResult) => void }[] = [];
    const p = preparing(syntheticApi({ obstacles: [] }));
    const api: PlanningApiV1 = {
      ...p.api,
      prepare: (region) =>
        new Promise((resolve) => {
          calls.push({ region, settle: resolve });
        })
    };
    const ok = (): PrepareResult => ({ ok: true, value: p.prepared });
    return { api, calls, ok };
  }

  test("trips inside a build's region share it while others get their own, all kept", async () => {
    const e = each();
    const prep = new Preparer(1000);
    const stop = new AbortController().signal;
    const a = prep.forTrip(e.api, at(0, 0), at(20_000, 0), stop);
    // Inside the first trip's search region, not its least region: the same build.
    const b = prep.forTrip(e.api, at(0, 10_000), at(5000, 10_000), stop);
    await flush();
    expect(e.calls.map((c) => c.region)).toEqual([searchRegion(at(0, 0), at(20_000, 0))]);
    // Far past it: a second build, and the first is not lost.
    const c = prep.forTrip(e.api, at(0, 80_000), at(5000, 80_000), stop);
    await flush();
    expect(e.calls).toHaveLength(2);
    const d = prep.forTrip(e.api, at(1000, 1000), at(4000, 1000), stop);
    await flush();
    expect(e.calls).toHaveLength(2);
    e.calls[0]?.settle(e.ok());
    e.calls[1]?.settle(e.ok());
    for (const r of await Promise.all([a, b, c, d])) {
      expect("version" in r).toBe(true);
    }
  });

  test("a build narrowed by a 413 past a trip sharing it: the trip gets its own", async () => {
    const e = each();
    const prep = new Preparer(1000);
    const stop = new AbortController().signal;
    const a = prep.forTrip(e.api, at(0, 0), at(20_000, 0), stop);
    const b = prep.forTrip(e.api, at(0, 10_000), at(5000, 10_000), stop);
    await flush();
    e.calls[0]?.settle({ ok: false, status: 413, error: "too large" });
    await flush();
    // The first build turned to its own trip's least region; the second trip asks for its own.
    expect(e.calls.map((c) => c.region)).toEqual([
      searchRegion(at(0, 0), at(20_000, 0)),
      tripRegion(at(0, 0), at(20_000, 0)),
      searchRegion(at(0, 10_000), at(5000, 10_000))
    ]);
    // A trip inside the narrowed build's region still shares it.
    const c = prep.forTrip(e.api, at(1000, 0), at(4000, 0), stop);
    await flush();
    expect(e.calls).toHaveLength(3);
    e.calls[1]?.settle(e.ok());
    e.calls[2]?.settle(e.ok());
    for (const r of await Promise.all([a, b, c])) {
      expect("version" in r).toBe(true);
    }
  });

  test("a 413 for a longer trip's region it shared: the trip asks for its own", async () => {
    const e = each();
    const prep = new Preparer(1000);
    const stop = new AbortController().signal;
    const a = prep.forTrip(e.api, at(0, 0), at(20_000, 0), stop);
    // Inside the first trip's least region: it shares the build throughout.
    const b = prep.forTrip(e.api, at(1000, 0), at(4000, 0), stop);
    await flush();
    e.calls[0]?.settle({ ok: false, status: 413, error: "too large" });
    await flush();
    e.calls[1]?.settle({ ok: false, status: 413, error: "still too large" });
    await flush();
    expect(await a).toEqual({ status: 413, body: { errors: ["still too large"] } });
    // The shorter trip asks for its own regions; its least is built.
    expect(e.calls.map((c) => c.region).slice(2)).toEqual([searchRegion(at(1000, 0), at(4000, 0))]);
    e.calls[2]?.settle(e.ok());
    expect("version" in (await b)).toBe(true);
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

  test("a corridor's sessions list the chart objects the provider's do", async () => {
    const inner = syntheticApi({
      obstacles: [],
      lines: [
        {
          class: "NAVLNE",
          points: [
            [0, 0],
            [1000, 0]
          ]
        }
      ]
    });
    const p = preparing(inner);
    const corridor = onPrepared(p.api, p.prepared, [[21, 59, 23, 61]]);
    const r = await corridor.session(
      { departure: NOW, until: NOW + 1000, speed: 3 },
      new AbortController().signal,
      async (s) => s.objects?.(at(-100, -100), at(1100, 100)).length
    );
    expect(r).toEqual({ ok: true, value: 1 });
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

  test("start and destination at one point build nothing: plan() answers 400", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    g[PLANNING_API] = p.api;
    const api = apiFor({ now: () => NOW }, () => new AbortController().signal, new Preparer(5));
    const r = await api.plan({ from: at(0, 0), to: at(0, 0) }, new AbortController().signal);
    expect(r.status).toBe(400);
    expect(p.calls).toHaveLength(0);
  });

  test("a trip too long to plan builds nothing", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    g[PLANNING_API] = p.api;
    const api = apiFor({ now: () => NOW }, () => new AbortController().signal, new Preparer(5));
    const r = await api.plan({ from: at(0, 0), to: at(70_000, 0) }, new AbortController().signal);
    expect(r.status).toBe(400);
    expect(p.calls).toHaveLength(0);
  });

  test("past maxDistance, a provider that surveys has the trip prepared, up to a corridor's reach", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    g[PLANNING_API] = {
      ...p.api,
      features: ["prepare", "survey", "corridor"],
      survey: () => Promise.resolve({ ok: false, status: 503, error: "none" })
    };
    const api = apiFor({ now: () => NOW }, () => new AbortController().signal, new Preparer(5));
    const waiting = await api.plan(
      { from: at(0, 0), to: at(70_000, 0) },
      new AbortController().signal
    );
    expect(waiting).toMatchObject({ status: 503, body: { preparing: true } });
    expect(p.calls).toHaveLength(1);
    // Past a corridor's reach: refused, building nothing.
    const far = await api.plan(
      { from: at(0, 0), to: at(DEFAULT_PLAN.corridorDistance + 1000, 0) },
      new AbortController().signal
    );
    expect(far.status).toBe(400);
    expect(p.calls).toHaveLength(1);
  });

  test("on the prepared index, a provider that checks bridges plans an air height", async () => {
    for (const [features, status] of [
      [["prepare", "objects"], 200],
      [["prepare"], 503]
    ] as const) {
      const p = preparing(syntheticApi({ obstacles: [] }));
      g[PLANNING_API] = { ...p.api, features };
      const api = apiFor({ now: () => NOW }, () => new AbortController().signal, new Preparer(5));
      const body = { from: at(0, 0), to: at(5000, 0), airHeight: 17 };
      await api.plan(body, new AbortController().signal);
      p.settle();
      await flush();
      const again = api.plan(body, new AbortController().signal);
      await flush();
      p.settle();
      const r = await again;
      expect([features, r.status]).toEqual([features, status]);
      if (status === 503) {
        expect(r.body).toMatchObject({ errors: [expect.stringMatching(/does not check bridges/)] });
      }
    }
  });

  test("the trip's index is prepared for the request's draft", async () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    g[PLANNING_API] = p.api;
    const drafts: (number | undefined)[] = [];
    class Spy extends Preparer {
      override forTrip(...args: Parameters<Preparer["forTrip"]>): ReturnType<Preparer["forTrip"]> {
        drafts.push(args[4]);
        return super.forTrip(...args);
      }
    }
    const api = apiFor({ now: () => NOW }, () => new AbortController().signal, new Spy(5));
    await api.plan({ from: at(0, 0), to: at(5000, 0), draft: 3.5 }, new AbortController().signal);
    await api.plan({ from: at(0, 0), to: at(5000, 0) }, new AbortController().signal);
    expect(drafts).toEqual([3.5, undefined]);
  });
});

describe("tripLimits", () => {
  const surveys = (api: PlanningApiV1): PlanningApiV1 => ({
    ...api,
    features: ["prepare", "survey", "corridor"],
    survey: () => Promise.resolve({ ok: false as const, status: 503, error: "none" })
  });

  test("past maxDistance where the provider surveys: a corridor's limits, on a planning box too", () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    const region = onPrepared(p.api, p.prepared);
    const far = tripLimits(surveys(p.api), region, 87_800);
    expect(far.maxDistance).toBe(DEFAULT_PLAN.corridorDistance);
    expect(far.maxWork).toBeGreaterThan(DEFAULT_PLAN.maxWork);
    // Without a survey the trip keeps the chart box's reach, and plan() refuses it.
    expect(tripLimits(p.api, region, 87_800).maxDistance).toBe(DEFAULT_PLAN.maxDistance);
  });

  test("within maxDistance on a planning box: the chart box's limits; in a corridor: a corridor's", () => {
    const p = preparing(syntheticApi({ obstacles: [] }));
    const box = tripLimits(surveys(p.api), onPrepared(p.api, p.prepared), 40_000);
    expect(box.maxDistance).toBe(DEFAULT_PLAN.maxDistance);
    expect(box.maxWork).toBe(40 * DEFAULT_PLAN.workPerKm);
    const corridor = onPrepared(p.api, p.prepared, [[21, 59, 23, 61]]);
    expect(tripLimits(p.api, corridor, 40_000).maxWork).toBeGreaterThan(DEFAULT_PLAN.maxWork);
  });
});

describe("/plan on a planning box released under it", () => {
  afterEach(() => {
    delete g[PLANNING_API];
  });

  /** A provider whose first `fail` sessions find the planning box released. */
  function releasing(fail: number) {
    const inner = syntheticApi({ obstacles: [{ x: 2500, y: 0, r: 600 }] });
    let sessions = 0;
    const api: PlanningApiV1 = {
      ...inner,
      session: (params, signal, job) =>
        ++sessions <= fail
          ? Promise.resolve({
              ok: false as const,
              status: 503,
              error: "the planning box was released; prepare it again"
            })
          : inner.session(params, signal, job)
    };
    return { api, count: () => sessions };
  }

  test("is prepared and planned again, once, on the index prepared the second time", async () => {
    const inner = syntheticApi({ obstacles: [{ x: 2500, y: 0, r: 600 }] });
    // Each preparation gives a handle of its own; the first is released before its session.
    const handles: { sessions: number; checks: number }[] = [];
    const api: PlanningApiV1 = {
      ...inner,
      features: ["prepare"],
      prepare: () => {
        const h = { sessions: 0, checks: 0 };
        handles.push(h);
        const released = handles.length === 1;
        const prepared: Prepared = {
          coverage: [21, 59, 23, 61],
          session: (params, signal, job) => {
            h.sessions++;
            return released
              ? Promise.resolve({
                  ok: false as const,
                  status: 503,
                  error: "the planning box was released; prepare it again"
                })
              : inner.session(params, signal, job);
          },
          routeCheck: (body, signal) => {
            h.checks++;
            return inner.routeCheck(body, signal);
          },
          release: () => undefined
        };
        return Promise.resolve({ ok: true as const, value: prepared });
      }
    };
    g[PLANNING_API] = api;
    const plugin = apiFor({ now: () => NOW }, () => new AbortController().signal, new Preparer(5));
    const r = await plugin.plan({ from: at(0, 0), to: at(5000, 0) }, new AbortController().signal);
    expect(r.status).toBe(200);
    expect(handles).toHaveLength(2);
    expect(handles[0]).toEqual({ sessions: 1, checks: 0 });
    expect(handles[1]?.sessions).toBeGreaterThan(0);
    expect(handles[1]?.checks).toBeGreaterThan(0);
  });

  test("released again, the refusal is the answer: never a route", async () => {
    const p = releasing(1000);
    g[PLANNING_API] = p.api;
    const api = apiFor({ now: () => NOW }, () => new AbortController().signal, new Preparer(5));
    const r = await api.plan({ from: at(0, 0), to: at(5000, 0) }, new AbortController().signal);
    expect(r.status).toBe(503);
    expect(boxReleased(r)).toBe(true);
    expect(p.count()).toBe(2);
  });
});

describe("a prepared index's session features", () => {
  test("objects and pilotage are served over it; prepare, survey and corridor are not", () => {
    const api = {
      ...syntheticApi({ obstacles: [] }),
      features: ["prepare", "survey", "corridor", "objects", "pilotage"]
    };
    const prepared: Prepared = {
      coverage: [21, 59, 23, 61],
      session: api.session.bind(api),
      routeCheck: api.routeCheck.bind(api),
      release: () => undefined
    };
    expect(onPrepared(api, prepared).features).toEqual(["objects", "pilotage"]);
  });
});
