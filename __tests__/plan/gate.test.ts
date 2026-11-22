import type { LonLat } from "../../src/foundation/geo";
import { parsePlanRequest } from "../../src/api/plan-request";
import type { PlanningApiV1, Session, Verdict } from "../../src/oracle/contract";
import { timeDeparture } from "../../src/plan/gate";
import { plan } from "../../src/plan/plan";
import type { Part } from "../../src/plan/stages";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, legStatus, syntheticApi } from "../helpers/synthetic-oracle";

/**
 * Tide gates (plan §4.3): a route that passes only at some states of the tide is offered
 * leaving at the earliest departure, up to the request's latest, at which the route check
 * passes every leg as the boat reaches it.
 */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");
const HOUR = 3_600_000;

/** A wall across x = 2500 past the region's edges, its one gap a bar that needs 1 m of water. */
function barred(tide: (t: number) => number): Chart {
  const wall = Array.from({ length: 81 }, (_, i) => ({
    x: 2500,
    y: -8000 + i * 200,
    r: 110
  })).filter((c) => Math.abs(c.y - 1500) > 300);
  return { obstacles: wall, tidal: [{ x: 2500, y: 1500, r: 450, needs: 1 }], tide };
}

/** Falling from 1 m at NOW: below 1 m for six hours, then above it for six. */
const falling = (t: number): number => 1 - 1.2 * Math.sin((2 * Math.PI * (t - NOW)) / (12 * HOUR));

interface Body {
  status: string;
  work?: number;
  departure?: string;
  arrival?: string;
  route: { coordinates: LonLat[] };
  check: { legs: { status: string; length: number }[] };
  gate?: {
    requested?: string;
    departure?: string;
    waitMinutes?: number;
    legs?: number[];
    reason?: string;
  };
  timing?: { departure: string; holds: string };
  fallback?: string;
  reason?: string;
}

async function planned(chart: Chart, latest?: number, fallback?: boolean) {
  const r = await plan(
    syntheticApi(chart),
    {
      from: at(0, 0),
      to: at(5000, 0),
      departure: NOW,
      // Tide timing at the request's corridor alone: `narrows.test.ts` times narrows.
      narrows: false,
      speed: 3,
      ...(latest !== undefined && { latestDeparture: latest }),
      ...(fallback !== undefined && { fallback })
    },
    NEVER,
    NOW
  );
  return { r, body: r.body as Body };
}

describe("tide gates", () => {
  test("without a latest departure, a bar the falling tide closes refuses the plan", async () => {
    const { r } = await planned(barred(falling));
    expect(r.status).toBe(422);
  });

  test("with one, the plan leaves at the earliest departure the tide lets over the bar", async () => {
    const chart = barred(falling);
    const { r, body } = await planned(chart, NOW + 12 * HOUR);
    expect(r.status).toBe(200);
    expect(body.fallback).toBeUndefined();
    const leave = Date.parse(body.departure as string);
    // Over the bar once the tide is back above 1 m, six hours on. Every 15-minute window the
    // gated leg overlaps must pass at its own lowest water, so the departure falls within a
    // slot or two of that, never before the tide allows.
    expect(leave).toBeGreaterThan(NOW + 5 * HOUR);
    expect(leave).toBeLessThanOrEqual(NOW + 6.5 * HOUR);
    expect(body.gate).toMatchObject({
      requested: new Date(NOW).toISOString(),
      departure: body.departure,
      waitMinutes: Math.round((leave - NOW) / 60_000)
    });
    expect(body.gate?.legs?.length).toBeGreaterThan(0);
    // Its timing is the departure it is proved for. The search over the whole verdict window
    // met the bar at its lowest water, so the route holds leaving then, not at any time.
    expect(body.timing).toMatchObject({ departure: body.departure, holds: "now" });
    // It arrives the sailing time after it leaves, at 3 m/s.
    const sailing = (body.check.legs.reduce((m, l) => m + l.length, 0) / 3) * 1000;
    const arrives = Date.parse(body.arrival as string) - leave;
    expect(Math.abs(arrives - sailing)).toBeLessThan(sailing * 0.01);
    // Through the gap, and every leg passes as the route check sees it then.
    const ys = body.route.coordinates.map((p) => p[1]);
    expect(Math.max(...ys)).toBeGreaterThan(at(0, 1000)[1]);
    expect(body.check.legs.every((l) => l.status === "ok")).toBe(true);
    // At the lowest tide the route crosses the bar, so only the timing makes it pass.
    const c = body.route.coordinates;
    const low = c.slice(1).some((b, i) => legStatus(chart, c[i] as LonLat, b, 40) !== "ok");
    expect(low).toBe(true);
  });

  test("a fallback route the gate times holds only leaving then, asked with fallback too", async () => {
    const { r, body } = await planned(barred(falling), NOW + 12 * HOUR, true);
    expect(r.status).toBe(200);
    expect(body.timing).toMatchObject({ departure: body.departure, holds: "now" });
  });

  test("when no departure up to the latest passes, the refusal says why", async () => {
    const { r, body } = await planned(barred(falling), NOW + 2 * HOUR);
    expect(r.status).toBe(422);
    expect(body.gate?.reason).toMatch(/no departure up to .* passes leg/);
  });

  test("the reply counts the timing's work with the searches', each once", async () => {
    const plain = await planned(barred(falling));
    const timed = await planned(barred(falling), NOW + 12 * HOUR);
    expect(timed.body.work as number).toBeGreaterThan(plain.body.work as number);
  });

  test("a route that passes at the departure is offered as it is, with no gate", async () => {
    const high = (): number => 2;
    const { r, body } = await planned(barred(high), NOW + 12 * HOUR);
    expect(r.status).toBe(200);
    expect(body.gate).toBeUndefined();
    expect(body.departure).toBeUndefined();
  });

  test("a latest departure before the departure, or more than a day after it, is refused", () => {
    const base = { from: [22, 60], to: [22.1, 60.1], departure: new Date(NOW).toISOString() };
    for (const latest of [NOW - HOUR, NOW + 25 * HOUR]) {
      const p = parsePlanRequest({ ...base, latestDeparture: new Date(latest).toISOString() }, NOW);
      expect(p.ok).toBe(false);
    }
    const ok = parsePlanRequest(
      { ...base, latestDeparture: new Date(NOW + 6 * HOUR).toISOString() },
      NOW
    );
    expect(ok.ok && ok.value.latestDeparture).toBe(NOW + 6 * HOUR);
    // ISO 8601 with a zone: no other form.
    for (const latest of ["Wed, 18 Nov 2026 12:00:00 GMT", "2026-11-18T12:00:00"]) {
      expect(parsePlanRequest({ ...base, latestDeparture: latest }, NOW).ok).toBe(false);
    }
  });

  test("latestDeparture is a real calendar day: 30 February is refused, not rolled into March", () => {
    // Date.parse would make it 2 March 07:00, inside this departure's 24 h.
    const base = { from: [22, 60], to: [22.1, 60.1], departure: "2026-03-02T00:00:00Z" };
    expect(parsePlanRequest({ ...base, latestDeparture: "2026-03-02T07:00:00Z" }, NOW).ok).toBe(
      true
    );
    expect(parsePlanRequest({ ...base, latestDeparture: "2026-02-30T07:00:00Z" }, NOW).ok).toBe(
      false
    );
  });
});

/** A planning API whose every leg gets `verdict(a, b)`, counting the segment queries. */
function fixedApi(verdict: (a: LonLat) => Verdict) {
  const calls = { n: 0 };
  const api = {
    defaults: () => ({ speed: 3, xteLimit: 30, probability: 0.01, planningBuffer: 10 }),
    async session(_p: unknown, _s: AbortSignal, job: (s: Session) => Promise<unknown>) {
      const s = {
        halfWidth: 10,
        box: () => verdict([0, 0]),
        segment: (a: LonLat) => (calls.n++, verdict(a)),
        work: () => calls.n * 100,
        pause: () => Promise.resolve()
      } as Session;
      return { ok: true, value: await job(s) };
    }
  } as unknown as PlanningApiV1;
  return { api, calls };
}

describe("the departure gate's legs", () => {
  const quay = at(0, 0);
  const off = at(30, 0);
  const sea = at(2000, 0);
  // A harbour part from the quay: its first leg is the berth leg, the rest open water.
  const parts: Part[] = [
    { kind: "harbour", end: "start", coordinates: [quay, off, sea], xteLimit: 0, berth: off }
  ];
  const g = { departure: NOW, latest: NOW + 6 * HOUR, speed: 3 };
  const rule = { accept: [], probability: 0.01 };
  const ctx = { rule, signal: NEVER, budget: 1e9 };
  const ok: Verdict = { status: "ok", risk: 0, flags: [] };

  test("a berth leg along its quay is not gated: its LAND is expected, as in the proof", async () => {
    const { api } = fixedApi((a) =>
      a === quay ? { status: "fail", risk: 0.9, flags: ["LAND"] } : ok
    );
    const t = await timeDeparture(api, g, parts, ctx);
    expect(t).toMatchObject({ ok: true, departure: NOW, gated: [] });
  });

  test("a berth leg into closed water still closes the gate", async () => {
    const { api } = fixedApi((a) =>
      a === quay ? { status: "fail", risk: 0.9, flags: ["LAND", "ENTRY_PROHIBITED"] } : ok
    );
    const t = await timeDeparture(api, g, parts, ctx);
    expect(t.ok).toBe(false);
  });

  test("a session the abort ends mid-way still counts the work it did", async () => {
    const calls = { n: 0 };
    const fail: Verdict = { status: "fail", risk: 0.9, flags: [] };
    const api = {
      defaults: () => ({ speed: 3, xteLimit: 30, probability: 0.01, planningBuffer: 10 }),
      async session(_p: unknown, _s: AbortSignal, job: (s: Session) => Promise<unknown>) {
        const s = {
          halfWidth: 10,
          box: () => fail,
          segment: () => (calls.n++, fail),
          work: () => calls.n * 100,
          pause: () => Promise.reject(new Error("aborted"))
        } as Session;
        try {
          return { ok: true, value: await job(s) };
        } catch {
          return { ok: false, status: 503, error: "aborted" };
        }
      }
    } as unknown as PlanningApiV1;
    const t = await timeDeparture(api, g, parts, ctx);
    // Queries over the whole horizon and one slot before the pause the abort ended: all counted.
    expect(calls.n).toBeGreaterThan(1);
    expect(t).toMatchObject({ ok: false, work: calls.n * 100 });
  });

  test("with its work spent, the gate asks nothing more, not even over the whole horizon", async () => {
    const { api, calls } = fixedApi(() => ok);
    const t = await timeDeparture(api, g, parts, { ...ctx, budget: 0 });
    expect({ ok: t.ok, calls: calls.n }).toEqual({ ok: false, calls: 0 });
  });
});
