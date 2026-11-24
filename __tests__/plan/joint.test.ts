import type { LonLat } from "../../src/foundation/geo";
import { haversine } from "../../src/foundation/geo";
import { eased, JOINT_REACH } from "../../src/plan/joint";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { joined, same } from "../../src/plan/proof";
import type { Part, Stage } from "../../src/plan/stages";
import { OK_ONLY } from "../../src/search/passes";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, legStatus, syntheticApi, xy } from "../helpers/synthetic-oracle";

/**
 * Joints (`plan/joint.ts`): a harbour part and the route meet at a handover each reached its
 * own way; the harbour part is drawn tight across it and takes over the route's first stretch.
 */

const NOW = Date.parse("2026-11-18T07:00:00Z");
/** The harbour corridor's half-width on the synthetic chart: xte 0 and its 10 m buffer. */
const HARBOUR_WIDTH = 10;

function stage(chart: Chart): Stage & { api: ReturnType<typeof syntheticApi> } {
  return {
    api: syntheticApi(chart),
    params: { departure: NOW, until: NOW + 3_600_000, speed: 3, xteLimit: 30 },
    signal: new AbortController().signal,
    opts: DEFAULT_PLAN,
    rule: OK_ONLY,
    fallback: false
  };
}

const lengthOf = (c: readonly LonLat[]): number =>
  c.slice(1).reduce((sum, p, i) => sum + haversine(c[i] as LonLat, p), 0);

async function ease(chart: Chart, parts: Part[]) {
  const st = stage(chart);
  const r = await eased(st, parts, 1_000_000);
  if (!r.ok) {
    throw new Error(r.error);
  }
  return { ...r.value, st };
}

/** Whether every leg of `part` passes the chart at the harbour corridor. */
const passes = (chart: Chart, part: Part): boolean =>
  part.coordinates
    .slice(1)
    .every((b, i) => legStatus(chart, part.coordinates[i] as LonLat, b, HARBOUR_WIDTH) === "ok");

describe("a harbour part's joint with the route", () => {
  // Out of the harbour southward to the handover, then the route eastward: a right angle.
  const start: Part = {
    kind: "harbour",
    end: "start",
    xteLimit: 0,
    coordinates: [at(0, 0), at(0, -300)]
  };
  const route: Part = {
    kind: "route",
    xteLimit: 30,
    coordinates: [at(0, -300), at(2000, -300), at(3000, 0)]
  };

  test("in open water the dog-leg at the handover is cut: the handover moves along the route's leg", async () => {
    const chart: Chart = { obstacles: [] };
    const { parts, st, work } = await ease(chart, [start, route]);
    const [h, r] = parts as [Part, Part];
    expect(lengthOf(joined(parts))).toBeLessThan(lengthOf(joined([start, route])) - 100);
    // The parts still meet, at a point of the route's own first leg, no farther than the reach.
    const meet = h.coordinates[h.coordinates.length - 1] as LonLat;
    expect(same(meet, r.coordinates[0])).toBe(true);
    const [x, y] = xy(meet);
    expect(y).toBeCloseTo(-300, 0);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThanOrEqual(JOINT_REACH + 1);
    // The rest of the route is as it was, and the ends are the plan's.
    expect(r.coordinates.slice(1)).toEqual(route.coordinates.slice(1));
    expect(h.coordinates[0]).toEqual(start.coordinates[0]);
    expect(passes(chart, h)).toBe(true);
    // One session at the harbour corridor, its work counted.
    expect(st.api.sessions.map((s) => s.xteLimit)).toEqual([0]);
    expect(work).toBeGreaterThan(0);
  });

  test("land inside the corner keeps the route off it: every leg of the harbour part still passes", async () => {
    const chart: Chart = { obstacles: [{ x: 120, y: -180, r: 90 }] };
    const { parts } = await ease(chart, [start, route]);
    const [h, r] = parts as [Part, Part];
    expect(passes(chart, h)).toBe(true);
    expect(same(h.coordinates[h.coordinates.length - 1], r.coordinates[0])).toBe(true);
    expect(lengthOf(joined(parts))).toBeLessThanOrEqual(lengthOf(joined([start, route])));
  });

  test("a berth leg stays as it is", async () => {
    const quay = at(-30, 0);
    const berthed: Part = { ...start, coordinates: [quay, ...start.coordinates], berth: at(0, 0) };
    const { parts } = await ease({ obstacles: [] }, [berthed, route]);
    const h = parts[0] as Part;
    expect(h.coordinates.slice(0, 2)).toEqual([quay, at(0, 0)]);
    expect(h.berth).toEqual(at(0, 0));
    expect(lengthOf(joined(parts))).toBeLessThan(lengthOf(joined([berthed, route])) - 100);
  });

  test("the destination's harbour part is eased the same way, sailed in its own direction", async () => {
    const before: Part = {
      kind: "route",
      xteLimit: 30,
      coordinates: [at(-3000, 0), at(-2000, -300), at(0, -300)]
    };
    const end: Part = {
      kind: "harbour",
      end: "end",
      xteLimit: 0,
      coordinates: [at(0, -300), at(0, 0)]
    };
    const chart: Chart = { obstacles: [] };
    const { parts } = await ease(chart, [before, end]);
    const [r, h] = parts as [Part, Part];
    expect(lengthOf(joined(parts))).toBeLessThan(lengthOf(joined([before, end])) - 100);
    expect(same(r.coordinates[r.coordinates.length - 1], h.coordinates[0])).toBe(true);
    expect(h.coordinates[h.coordinates.length - 1]).toEqual(at(0, 0));
    expect(r.coordinates.slice(0, -1)).toEqual(before.coordinates.slice(0, -1));
    expect(passes(chart, h)).toBe(true);
  });

  test("a route leg shorter than the reach is taken over whole, and the reach goes on along the next; a straight joint is left alone", async () => {
    const short: Part = {
      kind: "route",
      xteLimit: 30,
      coordinates: [at(0, -300), at(200, -300), at(3000, 0)]
    };
    const { parts } = await ease({ obstacles: [] }, [start, short]);
    const [h, r] = parts as [Part, Part];
    // JOINT_REACH metres along the route: 200 m of its first leg, the rest along its second.
    const meet = h.coordinates[h.coordinates.length - 1] as LonLat;
    expect(same(meet, r.coordinates[0])).toBe(true);
    expect(haversine(at(200, -300), meet)).toBeCloseTo(JOINT_REACH - 200, 0);
    expect(r.coordinates.slice(1)).toEqual([at(3000, 0)]);
    // Already straight: nothing to gain, nothing changed.
    const on: Part = { kind: "route", xteLimit: 30, coordinates: [at(0, -300), at(0, -2000)] };
    const straight = await ease({ obstacles: [] }, [start, on]);
    expect(straight.parts).toEqual([start, on]);
    // No harbour part, no joint.
    const alone = await ease({ obstacles: [] }, [route]);
    expect(alone.parts).toEqual([route]);
  });

  test("a part a few metres long at the handover is no wall: the reach goes on into the parts before it", async () => {
    // As planned from Parainen to Stenskär: the route runs 350 m past the harbour's way in to
    // a handover, a narrows part 12 m long lies there, and the harbour part turns back.
    const route: Part = {
      kind: "route",
      xteLimit: 30,
      coordinates: [at(-2000, 0), at(-100, 0), at(250, 0)]
    };
    const sliver: Part = { kind: "narrows", xteLimit: 0, coordinates: [at(250, 0), at(262, 0)] };
    const end: Part = {
      kind: "harbour",
      end: "end",
      xteLimit: 0,
      coordinates: [at(262, 0), at(-50, 10), at(-60, -300)]
    };
    const chart: Chart = { obstacles: [] };
    const { parts } = await ease(chart, [route, sliver, end]);
    const all = joined(parts);
    // The out-and-back is gone: nowhere does the route go east of where it turns south.
    expect(Math.max(...all.map((p) => xy(p)[0]))).toBeLessThan(0);
    expect(lengthOf(all)).toBeLessThan(lengthOf(joined([route, sliver, end])) - 600);
    // The sliver was taken over whole; the route ends where the harbour part begins.
    expect(parts.map((p) => p.kind)).toEqual(["route", "harbour"]);
    const [r, h] = parts as [Part, Part];
    expect(same(r.coordinates[r.coordinates.length - 1], h.coordinates[0])).toBe(true);
    expect(h.coordinates[h.coordinates.length - 1]).toEqual(at(-60, -300));
    expect(passes(chart, h)).toBe(true);
  });

  test("a route past the handover shorter than the reach is taken over whole", async () => {
    // Out of the harbour south, then 200 m east: the harbour part goes straight to the end.
    const short: Part = { kind: "route", xteLimit: 30, coordinates: [at(0, -300), at(200, -300)] };
    const { parts } = await ease({ obstacles: [] }, [start, short]);
    expect(parts.map((p) => p.kind)).toEqual(["harbour"]);
    const h = parts[0] as Part;
    expect(h.coordinates[0]).toEqual(start.coordinates[0]);
    expect(h.coordinates[h.coordinates.length - 1]).toEqual(at(200, -300));
    expect(lengthOf(joined(parts))).toBeLessThan(lengthOf(joined([start, short])) - 100);
  });

  test("with harbour parts at both ends, each is eased, and neither takes over the other", async () => {
    const s0: Part = {
      kind: "harbour",
      end: "start",
      xteLimit: 0,
      coordinates: [at(0, 0), at(0, -300)]
    };
    const mid: Part = {
      kind: "route",
      xteLimit: 30,
      coordinates: [at(0, -300), at(3000, -300), at(3000, 0)]
    };
    const e0: Part = {
      kind: "harbour",
      end: "end",
      xteLimit: 0,
      coordinates: [at(3000, 0), at(3300, 0)]
    };
    const { parts } = await ease({ obstacles: [] }, [s0, mid, e0]);
    expect(parts.map((p) => p.kind)).toEqual(["harbour", "route", "harbour"]);
    expect(parts[0]?.coordinates[0]).toEqual(at(0, 0));
    expect(parts[2]?.coordinates[(parts[2]?.coordinates.length ?? 1) - 1]).toEqual(at(3300, 0));
    expect(lengthOf(joined(parts))).toBeLessThan(lengthOf(joined([s0, mid, e0])) - 100);
  });
});
