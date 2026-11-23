import type { LonLat } from "../../src/foundation/geo";
import { haversine } from "../../src/foundation/geo";
import type { Verdict } from "../../src/oracle/contract";
import { plan } from "../../src/plan/plan";
import { OK_ONLY, passes } from "../../src/search/passes";
import type { TautRule } from "../../src/search/taut";
import { taut } from "../../src/search/taut";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, legVerdict, segDist, syntheticApi, xy } from "../helpers/synthetic-oracle";

/**
 * Taut-string refinement (plan §4.1 step 4): a route is drawn tight round what stops it, so a
 * free-water route is as short as the water allows, and never worse in any leg than before.
 */

const R = 40;
const NEVER = new AbortController().signal;
const ISLAND: Chart = { obstacles: [{ x: 2500, y: 0, r: 500 }] };
/** Round the island, past its corridor: the tangents and the arc between them, metres. */
function aroundIsland(): number {
  const d = 2500;
  const r = 500 + R;
  const tangent = Math.sqrt(d * d - r * r);
  return 2 * tangent + r * (Math.PI - 2 * Math.acos(r / d));
}

const length = (p: readonly LonLat[]): number =>
  p.slice(1).reduce((s, b, k) => s + haversine(p[k] as LonLat, b), 0);

const open = { exhausted: () => false, pause: () => Promise.resolve() };

/** As the strict search prices legs: length where it passes, nowhere else. */
const strict: TautRule = {
  cost: (v) => (passes(v, OK_ONLY) ? 1 : Infinity),
  rank: (v) => (passes(v, OK_ONLY) ? 0 : 3)
};

const zigzag: LonLat[] = [
  at(0, 0),
  at(900, 700),
  at(1700, 620),
  at(2400, 900),
  at(3100, 640),
  at(3900, 760),
  at(5000, 0)
];

describe("taut-string refinement", () => {
  test("an L of long legs in a narrow channel, open water at its corner, has its corner cut", async () => {
    // Two 3 km legs meeting at a right angle, as a chain of fairway lines turns: a channel 5 m
    // wider than the corridor along each, opening into a bay 400 m round the corner. Turning
    // either long leg sweeps it into the channel's side; only a chord near the corner passes.
    const ell: LonLat[] = [at(0, 0), at(3000, 0), at(3000, -3000)];
    const path = ell.map(xy);
    const water = (x: number, y: number): boolean =>
      Math.hypot(x - 3000, y) <= 400 ||
      path.slice(1).some((q, k) => segDist(x, y, path[k] as [number, number], q) <= 5);
    const check = (a: LonLat, b: LonLat): Verdict => {
      const [ax, ay] = xy(a);
      const [bx, by] = xy(b);
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 5);
      for (let i = 0; i <= n; i++) {
        if (!water(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n)) {
          return { status: "fail", risk: 1, flags: ["LAND"] };
        }
      }
      return { status: "ok", risk: 0, flags: [] };
    };
    const tight = await taut(ell, check, open, { ...strict, cutCorners: true });
    expect(tight.slice(1).every((b, k) => check(tight[k] as LonLat, b).status === "ok")).toBe(true);
    // A chord 400 m back and on saves 2 × 400 − 566 m: about 230 m.
    expect(length(tight)).toBeLessThan(length(ell) - 150);
    expect(tight[0]).toEqual(ell[0]);
    expect(tight[tight.length - 1]).toEqual(ell[2]);
    // Without corner cutting, as a search's route is drawn, the L stays.
    expect(length(await taut(ell, check, open, strict))).toBeCloseTo(length(ell), 0);
  });

  test("a corner whose open water lies along the leg in is cut from there straight on", async () => {
    // Narrow channels along both legs; open water only in the triangle between the last 1000 m
    // of the leg in and the next point, as where a channel opens toward the next turn. The best
    // cut leaves the leg in 1000 m back and runs straight to the next point.
    const ell: LonLat[] = [at(0, 0), at(3000, 0), at(3000, -1500)];
    const path = ell.map(xy);
    const inTriangle = (x: number, y: number): boolean =>
      x <= 3000 && y <= 0 && y >= -1.5 * (x - 2000) - 1e-6;
    const water = (x: number, y: number): boolean =>
      inTriangle(x, y) ||
      path.slice(1).some((q, k) => segDist(x, y, path[k] as [number, number], q) <= 5);
    const check = (a: LonLat, b: LonLat): Verdict => {
      const [ax, ay] = xy(a);
      const [bx, by] = xy(b);
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 5);
      for (let i = 0; i <= n; i++) {
        if (!water(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n)) {
          return { status: "fail", risk: 1, flags: ["LAND"] };
        }
      }
      return { status: "ok", risk: 0, flags: [] };
    };
    const tight = await taut(ell, check, open, { ...strict, cutCorners: true });
    expect(tight.slice(1).every((b, k) => check(tight[k] as LonLat, b).status === "ok")).toBe(true);
    // 2000 m on and the 1803 m diagonal: 3803 m. The same way back and on gives at best 3914 m.
    expect(length(tight)).toBeLessThan(3850);
  });

  test("a zig-zag round an island is drawn tight to it, with fewer legs", async () => {
    const check = (a: LonLat, b: LonLat): Verdict => legVerdict(ISLAND, a, b, R);
    expect(zigzag.slice(1).every((b, k) => check(zigzag[k] as LonLat, b).status === "ok")).toBe(
      true
    );
    const tight = await taut(zigzag, check, open, strict);
    expect(length(tight)).toBeLessThan(length(zigzag));
    // A polyline round an arc is a little longer than the arc itself.
    expect(length(tight)).toBeLessThanOrEqual(aroundIsland() * 1.01);
    expect(tight.length).toBeLessThan(zigzag.length);
    expect(tight[0]).toEqual(zigzag[0]);
    expect(tight[tight.length - 1]).toEqual(zigzag[zigzag.length - 1]);
    // Every leg it keeps passes: strict stays strict.
    expect(tight.slice(1).every((b, k) => check(tight[k] as LonLat, b).status === "ok")).toBe(true);
  });

  test("a fallback route never draws in more failing water than it had", async () => {
    // A shallow the fallback may cross, beside the route round it.
    const chart: Chart = { obstacles: [], shallows: [{ x: 2500, y: 0, r: 500 }] };
    const check = (a: LonLat, b: LonLat): Verdict => legVerdict(chart, a, b, R);
    const fallback: TautRule = {
      cost: (v) => (v.status === "fail" ? 1000 * v.risk + 100 : 1),
      rank: (v) => (v.status === "ok" ? 0 : 3)
    };
    const failing = (p: readonly LonLat[]): number =>
      p
        .slice(1)
        .reduce(
          (s, b, k) =>
            s + (check(p[k] as LonLat, b).status === "fail" ? haversine(p[k] as LonLat, b) : 0),
          0
        );
    // A route that grazes the shallow, with legs that fail there; the straight line crosses it.
    const grazing: LonLat[] = [at(0, 0), at(1500, 700), at(2500, 520), at(3500, 700), at(5000, 0)];
    const straight: LonLat[] = [at(0, 0), at(5000, 0)];
    expect(failing(grazing)).toBeGreaterThan(0);
    expect(failing(straight)).toBeGreaterThan(failing(grazing));
    const tight = await taut(grazing, check, open, fallback);
    expect(failing(tight)).toBeLessThanOrEqual(failing(grazing));
    expect(length(tight)).toBeLessThan(length(grazing));
    // The shortcut across the whole shallow, shorter as it is, is not taken.
    expect(tight.length).toBeGreaterThan(2);
  });

  test("with its work spent part way, it keeps a route of checked legs, asking nothing more", async () => {
    let checks = 0;
    const check = (a: LonLat, b: LonLat): Verdict => {
      checks++;
      return legVerdict(ISLAND, a, b, R);
    };
    const tight = await taut(
      zigzag,
      check,
      { exhausted: () => checks >= 20, pause: () => Promise.resolve() },
      strict
    );
    expect(checks).toBeLessThanOrEqual(20);
    const verdict = (a: LonLat, b: LonLat) => legVerdict(ISLAND, a, b, R);
    expect(tight.slice(1).every((b, k) => verdict(tight[k] as LonLat, b).status === "ok")).toBe(
      true
    );
    expect(length(tight)).toBeLessThanOrEqual(length(zigzag));
  });

  test("a route through staggered islands is drawn tight, not left zig-zagging", async () => {
    const islands: Chart = {
      obstacles: [
        { x: 1500, y: 150, r: 300 },
        { x: 2600, y: -200, r: 350 },
        { x: 3700, y: 250, r: 300 },
        { x: 2100, y: 700, r: 250 },
        { x: 3100, y: -800, r: 300 }
      ]
    };
    const r = await plan(
      syntheticApi(islands),
      // At the request's corridor alone: narrows price squares, not legs (`narrows.test.ts`).
      { from: at(0, 0), to: at(5000, 0), departure: 0, speed: 3, xteLimit: 30, narrows: false },
      NEVER,
      0
    );
    expect(r.status).toBe(200);
    const body = r.body as { length: number; route: { coordinates: LonLat[] } };
    // Pulled alone it turned on the search's square centres: 5186 m in 6 legs.
    expect(body.length).toBeLessThan(5175);
    expect(body.route.coordinates.length).toBeLessThan(7);
  });
});
