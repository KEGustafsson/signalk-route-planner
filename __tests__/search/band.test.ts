import fc from "fast-check";
import type { LonLat } from "../../src/foundation/geo";
import { haversine } from "../../src/foundation/geo";
import type { Verdict } from "../../src/oracle/contract";
import { aroundTurns, bandAroundTurns, bandShortest, pieces } from "../../src/search/band";
import { OK_ONLY, passes } from "../../src/search/passes";
import type { TautRule } from "../../src/search/taut";
import { taut } from "../../src/search/taut";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, legVerdict, xy } from "../helpers/synthetic-oracle";

/**
 * Band refinement (plan §4.1 step 16): a route the search led round the long side of an islet
 * is moved to the short side, every leg checked; the taut string cannot, keeping its way round.
 */

const R = 10;
const open = { exhausted: () => false, pause: () => Promise.resolve() };
const strict: TautRule = {
  cost: (v) => (passes(v, OK_ONLY) ? 1 : Infinity),
  rank: (v) => (passes(v, OK_ONLY) ? 0 : 3),
  cutCorners: true,
  passing: true
};
const length = (p: readonly LonLat[]): number =>
  p.slice(1).reduce((s, b, k) => s + haversine(p[k] as LonLat, b), 0);

/** An islet just north of the straight line, and a reef on it: the way south of the islet is short. */
const ISLET: Chart = {
  obstacles: [
    { x: 2000, y: 150, r: 200 },
    { x: 2000, y: -400, r: 150 }
  ]
};
/** Round the islet's north side, as a search led by its squares may leave it. */
const NORTH: LonLat[] = [at(0, 0), at(1600, 500), at(2400, 500), at(4000, 0)];

describe("band refinement", () => {
  test("a route north of an islet is moved south of it, shorter, every leg passing", async () => {
    const check = (a: LonLat, b: LonLat): Verdict => legVerdict(ISLET, a, b, R);
    expect(NORTH.slice(1).every((b, k) => passes(check(NORTH[k] as LonLat, b), OK_ONLY))).toBe(
      true
    );
    const tight = await taut(NORTH, check, open, strict);
    const band = await bandShortest(NORTH, check, open, OK_ONLY);
    expect(band).toBeDefined();
    // Drawn tight after, as the planner does.
    const b = await taut(band as LonLat[], check, open, strict);
    expect(b.slice(1).every((q, k) => passes(check(b[k] as LonLat, q), OK_ONLY))).toBe(true);
    expect(b[0]).toEqual(NORTH[0]);
    expect(b[b.length - 1]).toEqual(NORTH[NORTH.length - 1]);
    // Between the islet (y −50 at its south) and the reef (y −250 at its north).
    const mid = b.map(xy).filter(([x]) => Math.abs(x - 2000) < 150);
    expect(mid.length === 0 || mid.every(([, y]) => y < -50 && y > -250)).toBe(true);
    // The taut string keeps the north side, about 4076 m; the band's way south about 4002 m.
    expect(length(b)).toBeLessThan(length(tight) - 50);
  });

  test("with its work spent, it answers none", async () => {
    let n = 0;
    const check = (a: LonLat, b: LonLat): Verdict => {
      n++;
      return legVerdict(ISLET, a, b, R);
    };
    const spent = { exhausted: () => n > 20, pause: () => Promise.resolve() };
    expect(await bandShortest(NORTH, check, spent, OK_ONLY)).toBeUndefined();
  });

  test("a route its band cannot shorten comes back no longer, its ends kept", async () => {
    // Open water: the straight line, a bent route's way, is what the grid finds near it.
    const check = (a: LonLat, b: LonLat): Verdict => legVerdict({ obstacles: [] }, a, b, R);
    const bent: LonLat[] = [at(0, 0), at(1000, 300), at(3000, 0)];
    const b = (await bandShortest(bent, check, open, OK_ONLY)) as LonLat[];
    expect(length(b)).toBeLessThanOrEqual(length(bent));
    expect(b[0]).toEqual(bent[0]);
    expect(b[b.length - 1]).toEqual(bent[2]);
  });

  test("pieces cover the route, each joined to the next where it was cut", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.integer({ min: -5000, max: 5000 }), fc.integer({ min: -5000, max: 5000 })),
          {
            minLength: 2,
            maxLength: 8
          }
        ),
        fc.integer({ min: 500, max: 6000 }),
        fc.boolean(),
        (pts, window, half) => {
          const route = pts.map(([x, y]) => at(x, y));
          const ps = pieces(route, window, half ? window / 2 : 0);
          const lastPiece = ps[ps.length - 1] ?? [];
          const joins = ps.slice(1).every((p, k) => {
            const prev = ps[k] as LonLat[];
            return haversine(prev[prev.length - 1] as LonLat, p[0] as LonLat) < 1e-6;
          });
          const total = ps.reduce((s, p) => s + length(p), 0);
          const longest = Math.max(...ps.map(length));
          return (
            joins &&
            Math.abs(total - length(route)) <= 1e-3 * length(route) + 1e-6 &&
            longest <= window * 1.001 &&
            ps[0]?.[0] === route[0] &&
            lastPiece[lastPiece.length - 1] === route[route.length - 1]
          );
        }
      )
    );
  });

  test("round its turns, a fine grid takes a gap between two islets the route went round", async () => {
    // Two islets with a gap between them, 25 m of the hull's track; the route round the north.
    const chart: Chart = {
      obstacles: [
        { x: 2000, y: -310, r: 300 },
        { x: 2000, y: 335, r: 300 }
      ]
    };
    const check = (a: LonLat, b: LonLat): Verdict => legVerdict(chart, a, b, R);
    const round: LonLat[] = [at(0, 12), at(1500, 700), at(2500, 700), at(4000, 12)];
    expect(round.slice(1).every((q, k) => passes(check(round[k] as LonLat, q), OK_ONLY))).toBe(
      true
    );
    const fine = await bandAroundTurns(round, check, open, OK_ONLY, {
      step: 30,
      width: 800,
      reach: 1500
    });
    const b = await taut(fine as LonLat[], check, open, strict);
    expect(b.slice(1).every((q, k) => passes(check(b[k] as LonLat, q), OK_ONLY))).toBe(true);
    expect(b[0]).toEqual(round[0]);
    expect(b[b.length - 1]).toEqual(round[3]);
    // Through the gap: about 4000 m, where the way round is over 4500.
    expect(length(b)).toBeLessThan(4100);
  });

  test("the stretches round turns and the straight legs between cover the route, alternating", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.integer({ min: -5000, max: 5000 }), fc.integer({ min: -5000, max: 5000 })),
          { minLength: 2, maxLength: 8 }
        ),
        fc.integer({ min: 50, max: 3000 }),
        (pts, reach) => {
          const route = pts.map(([x, y]) => at(x, y));
          const ps = aroundTurns(route, reach);
          const total = ps.reduce((sum, p) => sum + length(p.piece), 0);
          const alternate = ps.slice(1).every((p, k) => p.turn !== ps[k]?.turn);
          const joins = ps.slice(1).every((p, k) => {
            const prev = ps[k]?.piece ?? [];
            return haversine(prev[prev.length - 1] as LonLat, p.piece[0] as LonLat) < 1e-6;
          });
          // A route with no turn is one straight piece.
          const none = route.length > 2 || (ps.length === 1 && ps[0]?.turn === false);
          return (
            alternate &&
            joins &&
            none &&
            Math.abs(total - length(route)) <= 1e-3 * length(route) + 1e-6
          );
        }
      )
    );
  });
});
