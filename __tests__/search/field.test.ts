import fc from "fast-check";
import type { LonLat } from "../../src/foundation/geo";
import { frameAt, haversine } from "../../src/foundation/geo";
import type { Raster, Session, Verdict } from "../../src/oracle/contract";
import { RASTER } from "../../src/oracle/contract";
import { Field, fieldOf, hasRaster, rasterOf, settledCheck } from "../../src/search/field";
import { bowOf, cellsOf } from "../../src/search/field-geometry";
import type { PassRule } from "../../src/search/passes";
import { OK_ONLY } from "../../src/search/passes";

/** The raster field (`search/field.ts`): a leg settled on the session's raster, or not at all. */

const Z = 20;
const N = 2 ** Z;
/** A cell's byte by status, as signalk-underkeel's raster gives it. */
const OK = 0;
const LAND = 2 | RASTER.RISKY | RASTER.STUCK;
const UNVERIFIED = 3;
/** Fails at this water, but a higher one in the window may open it. */
const TIDAL = 2 | RASTER.RISKY;

/** The north-west cell of the test area, near 60° N 22° E. */
const [OX, OY] = cellsOf([22, 60], N).map(Math.floor) as [number, number];

/** The point at cell coordinates (x, y) from the test area's corner. */
function at(x: number, y: number): LonLat {
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (OY + y)) / N)));
  return [((OX + x) / N) * 360 - 180, (lat * 180) / Math.PI];
}

/** A cell's ground size at the test area, metres. */
const CELL_M = haversine(at(0, 0), at(1, 0));

interface Cell {
  byte: number;
  flags?: string[];
}

/** A session serving a raster of `cell(x, y)`, cells counted from the test area's corner. */
function session(
  cell: (x: number, y: number) => Cell,
  how: { halfWidth?: number; reach?: number; exact?: (a: LonLat, b: LonLat) => Verdict } = {}
): Session & { blocks: number; asked: number } {
  const s = {
    halfWidth: how.halfWidth ?? 2,
    blocks: 0,
    asked: 0,
    box: (): Verdict => ({ status: "fail", risk: 1, flags: ["EXACT"] }),
    segment: (a: LonLat, b: LonLat): Verdict => {
      s.asked++;
      return how.exact?.(a, b) ?? { status: "fail", risk: 1, flags: ["EXACT"] };
    },
    work: () => 0,
    pause: () => Promise.resolve(),
    rasterZoom: Z,
    raster: (x0: number, y0: number, cols: number, rows: number): Raster => {
      s.blocks++;
      const cells = new Uint8Array(cols * rows);
      const flags = new Uint8Array(cols * rows);
      const sets: string[][] = [];
      const keys = new Map<string, number>();
      const put = (i: number, j: number, c: Cell): void => {
        const key = (c.flags ?? []).join("+");
        let set = keys.get(key);
        if (set === undefined) {
          set = sets.push(c.flags ?? []) - 1;
          keys.set(key, set);
        }
        cells[j * cols + i] = c.byte;
        flags[j * cols + i] = set;
      };
      const few = (cell as Partial<Sparse>).bad;
      if (few) {
        // Open water but for a few cells: the block is filled once, not asked cell by cell.
        put(0, 0, open());
        cells.fill(OK);
        for (const [key, c] of Object.entries(few)) {
          const [x, y] = key.split(",").map(Number) as [number, number];
          const [i, j] = [x + OX - x0, y + OY - y0];
          if (i >= 0 && j >= 0 && i < cols && j < rows) {
            put(i, j, c);
          }
        }
      } else {
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            put(i, j, cell(x0 + i - OX, y0 + j - OY));
          }
        }
      }
      return { z: Z, x0, y0, cols, rows, cells, flags, flagSets: sets, reach: how.reach ?? 0 };
    }
  };
  return s;
}

const open = (): Cell => ({ byte: OK });

/** A chart of open water but for a few cells, each as "x,y". */
interface Sparse {
  (x: number, y: number): Cell;
  bad: Record<string, Cell>;
}

/** Open water but for the cells `bad` holds. */
function but(bad: Record<string, Cell>): Sparse {
  const cell = (x: number, y: number): Cell => bad[`${x},${y}`] ?? open();
  return Object.assign(cell, { bad });
}

const field = (s: Session, rule: PassRule = OK_ONLY): Field => {
  if (!hasRaster(s)) {
    throw new Error("no raster");
  }
  return new Field(s, rule);
};

describe("a leg on the raster", () => {
  test("passes where every cell near it passes; no leg is asked of the chart", () => {
    const s = session(open);
    const f = field(s);
    expect(f.leg(at(10.5, 10.5), at(300.5, 140.5))).toBe(true);
    expect(f.stats).toMatchObject({ passed: 1, failed: 0, asked: 0 });
    expect(s.asked).toBe(0);
    // Two blocks of 256 cells a side, each read once.
    expect(s.blocks).toBe(f.stats.blocks);
    const read = s.blocks;
    f.leg(at(10.5, 10.5), at(300.5, 140.5));
    expect(s.blocks).toBe(read);
  });

  test("fails where land lies on it or inside its corridor", () => {
    const land = { byte: LAND, flags: ["LAND"] };
    expect(field(session(but({ "50,20": land }))).leg(at(10.5, 20.5), at(90.5, 20.5))).toBe(false);
    // A wide corridor: 40 m to each side reaches a cell two rows off the leg.
    const wide = session(but({ "50,22": land }), { halfWidth: 40 });
    expect(2 * CELL_M).toBeLessThan(39);
    expect(field(wide).leg(at(10.5, 20.5), at(90.5, 20.5))).toBe(false);
  });

  test("is not known where land lies at the corridor's edge, and passes clear of it", () => {
    const land = { byte: LAND, flags: ["LAND"] };
    // The leg runs 2 m from the cell's edge, the corridor's own half-width: neither surely in
    // nor surely out.
    const edge = 2 / CELL_M;
    const s = session(but({ "50,20": land }));
    expect(field(s).leg(at(10.5, 20 - edge), at(90.5, 20 - edge))).toBeUndefined();
    expect(field(s).leg(at(10.5, 20 - 3 * edge), at(90.5, 20 - 3 * edge))).toBe(true);
    // Past the leg's end by less than the half-width: the corridor reaches past its ends.
    expect(field(s).leg(at(10.5, 20.5), at(50 - edge / 2, 20.5))).not.toBe(true);
    expect(field(s).leg(at(10.5, 20.5), at(50 - 4 * edge, 20.5))).toBe(true);
  });

  test("a cell within the chart's reach of the corridor keeps it from passing", () => {
    const land = { byte: LAND, flags: ["LAND"] };
    const bad = but({ "50,23": land });
    const [a, b] = [at(10.5, 20.5), at(90.5, 20.5)];
    expect(field(session(bad)).leg(a, b)).toBe(true);
    // 2.5 cells off the leg: within a 60 m reach, outside the corridor.
    expect(field(session(bad, { reach: 60 })).leg(a, b)).toBeUndefined();
  });

  test("a reach too wide to scan leaves a clear leg to the exact check; land in the corridor still fails it", () => {
    const land = { byte: LAND, flags: ["LAND"] };
    // As a chart of poor survey quality: every tile within 1.9 km of a corridor counts.
    const s = session(but({ "50,60": land }), { reach: 1900 });
    const f = field(s);
    expect(f.leg(at(10.5, 20.5), at(90.5, 20.5))).toBeUndefined();
    // Only the blocks the corridor itself lies in were read, not the reach around it.
    expect(s.blocks).toBe(1);
    expect(f.leg(at(10.5, 60.5), at(90.5, 60.5))).toBe(false);
    // A small box is still scanned for land in it; a large one is left to the exact check.
    expect(f.box(at(45, 65), at(55, 55))).toBe(false);
    expect(f.box(at(100, 400), at(400, 100))).toBeUndefined();
    expect(s.blocks).toBe(1);
  });

  test("water a higher tide may open, a split cell and a cell to ask about are not known", () => {
    const [a, b] = [at(10.5, 20.5), at(90.5, 20.5)];
    for (const byte of [TIDAL, LAND | RASTER.MIXED, OK | RASTER.ASK, LAND | RASTER.ASK]) {
      expect(field(session(but({ "50,20": { byte } }))).leg(a, b)).toBeUndefined();
    }
    // A split cell whose parts together pass, passes.
    expect(field(session(but({ "50,20": { byte: OK | RASTER.MIXED } }))).leg(a, b)).toBe(true);
  });

  test("unverified water passes only by a rule that accepts its flags, at a risk under the probability", () => {
    const [a, b] = [at(10.5, 20.5), at(90.5, 20.5)];
    const water = (byte: number, flags: string[]) => session(() => ({ byte, flags }));
    const accepting: PassRule = { accept: ["NOT_FOR_NAVIGATION"], probability: 0.01 };
    const nfn = ["DREDGED", "NOT_FOR_NAVIGATION"];
    expect(field(water(UNVERIFIED, nfn), accepting).leg(a, b)).toBe(true);
    // Not accepted: no water level changes its flags.
    expect(field(water(UNVERIFIED, nfn)).leg(a, b)).toBe(false);
    expect(field(water(UNVERIFIED, ["NO_COVERAGE"]), accepting).leg(a, b)).toBe(false);
    // At or over the probability: not passed; a higher water may bring it under.
    expect(field(water(UNVERIFIED | RASTER.RISKY, nfn), accepting).leg(a, b)).toBeUndefined();
    expect(field(water(UNVERIFIED | RASTER.RISKY | RASTER.STUCK, nfn), accepting).leg(a, b)).toBe(
      false
    );
  });

  test("a leg near a pole, a quarter round the world or bowed off its rhumb line is not settled", () => {
    const f = field(session(open));
    expect(f.leg([22, 81], [22.01, 81])).toBeUndefined();
    expect(f.leg([0, 10], [100, 10])).toBeUndefined();
    // 60 km east–west at 60° N bows over 100 m.
    expect(bowOf([22, 60], [23.08, 60])).toBeGreaterThan(10);
    expect(f.leg([22, 60], [23.08, 60])).toBeUndefined();
    expect(f.stats.asked).toBe(3);
  });

  test("a block the session refuses is not known; any other failure is thrown", () => {
    const refusing = session(open);
    refusing.raster = () => {
      throw new RangeError("off the grid");
    };
    expect(field(refusing).leg(at(1.5, 1.5), at(9.5, 1.5))).toBeUndefined();
    const broken = session(open);
    broken.raster = () => {
      throw new Error("index gone");
    };
    expect(() => field(broken).leg(at(1.5, 1.5), at(9.5, 1.5))).toThrow("index gone");
  });
});

describe("the great circle's bow", () => {
  test("as far as a leg's length squared: under a metre for 5 km east–west at 60° N", () => {
    const a: LonLat = [22, 60];
    const east: LonLat = [22 + 5000 / (111_195 * Math.cos(Math.PI / 3)), 60];
    expect(bowOf(a, east)).toBeGreaterThan(0.7);
    expect(bowOf(a, east)).toBeLessThan(1);
    expect(bowOf(a, a)).toBe(0);
  });
});

describe("a box on the raster", () => {
  const land = { byte: LAND, flags: ["LAND"] };

  test("passes in open water, fails with a closed cell inside it", () => {
    const f = field(session(but({ "50,50": land })));
    expect(f.box(at(10, 30), at(30, 10))).toBe(true);
    expect(f.box(at(40, 60), at(60, 40))).toBe(false);
  });

  test("is not known with a closed cell in the ring its verdict reads past it", () => {
    // 40 m of corridor: the ring reaches √2 · 40 m, three cells, past the box.
    const f = field(session(but({ "62,50": land }), { halfWidth: 40 }));
    expect(f.box(at(40, 60), at(60, 40))).toBeUndefined();
    expect(f.box(at(20, 60), at(40, 40))).toBe(true);
  });
});

describe("settledCheck", () => {
  const rule: PassRule = OK_ONLY;
  const exact = (): Verdict => ({ status: "marginal", risk: 0.3, flags: ["EXACT"] });

  test("a session without a raster checks every leg itself", () => {
    const s = session(open);
    const plain: Session = {
      halfWidth: 2,
      box: s.box,
      segment: s.segment,
      work: s.work,
      pause: s.pause
    };
    expect(hasRaster(plain)).toBe(false);
    expect(rasterOf(plain)).toEqual({});
    expect(fieldOf(plain, rule)).toBeUndefined();
    expect(settledCheck(plain, rule, exact)).toBe(exact);
  });

  test("a settled leg carries no more than whether it passes; any other is the exact check's", () => {
    const s = session(but({ "50,20": { byte: LAND, flags: ["LAND"] }, "50,40": { byte: TIDAL } }));
    const check = settledCheck(s, rule, exact);
    expect(check(at(10.5, 30.5), at(90.5, 30.5))).toEqual({ status: "ok", risk: 0, flags: [] });
    expect(check(at(10.5, 20.5), at(90.5, 20.5)).status).toBe("fail");
    expect(check(at(10.5, 40.5), at(90.5, 40.5))).toEqual(exact());
    // One field a session and rule: its blocks are read once.
    expect(fieldOf(s, rule)).toBe(fieldOf(s, rule));
    expect(fieldOf(s, { accept: ["NOT_FOR_NAVIGATION"], probability: 0.01 })).not.toBe(
      fieldOf(s, rule)
    );
  });

  test("a session that wraps another serves its raster", () => {
    const s = session(open);
    const wrapped: Session = {
      halfWidth: 2,
      box: s.box,
      segment: s.segment,
      work: s.work,
      pause: s.pause,
      ...rasterOf(s)
    };
    expect(field(wrapped).leg(at(1.5, 1.5), at(9.5, 1.5))).toBe(true);
    expect(s.blocks).toBe(1);
  });
});

describe("the field against the ground (property)", () => {
  /** Distance from the segment a–b to the cell (x, y)'s square, ground metres, sampled along the leg. */
  function ground(a: LonLat, b: LonLat, x: number, y: number): number {
    const frame = frameAt(at(x + 0.5, y + 0.5));
    const corners = [at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)].map((p) =>
      frame.toXY(p)
    );
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const [pa, pb] = [frame.toXY(a), frame.toXY(b)];
    let d = Infinity;
    for (let k = 0; k <= 400; k++) {
      const px = pa[0] + ((pb[0] - pa[0]) * k) / 400;
      const py = pa[1] + ((pb[1] - pa[1]) * k) / 400;
      d = Math.min(d, Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(y0 - py, 0, py - y1)));
    }
    return d;
  }

  test("a leg it passes has no closed cell in its corridor; one it fails has one within it", () => {
    const point = fc.tuple(
      fc.double({ min: 2, max: 60, noNaN: true }),
      fc.double({ min: 2, max: 60, noNaN: true })
    );
    // Where along the leg a closed cell is put on it, if one is.
    const across = fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined });
    const cells = fc.uniqueArray(
      fc.tuple(fc.integer({ min: 0, max: 62 }), fc.integer({ min: 0, max: 62 })),
      {
        maxLength: 12,
        selector: ([x, y]) => `${x},${y}`
      }
    );
    const wrong: string[] = [];
    fc.assert(
      fc.property(
        point,
        point,
        cells,
        fc.constantFrom(2, 12, 40),
        across,
        (p, q, some, halfWidth, t) => {
          // The cell under the point a fraction `t` along the leg: the leg crosses it, so it lies
          // inside the corridor at any half-width, the slack the check below allows included.
          const crossed: [number, number][] =
            t === undefined
              ? []
              : [[Math.floor(p[0] + (q[0] - p[0]) * t), Math.floor(p[1] + (q[1] - p[1]) * t)]];
          const bad = [...some, ...crossed];
          const closed = Object.fromEntries(
            bad.map(([x, y]) => [`${x},${y}`, { byte: LAND, flags: ["LAND"] }])
          );
          const f = field(session(but(closed), { halfWidth }));
          const [a, b] = [at(p[0], p[1]), at(q[0], q[1])];
          const known = f.leg(a, b);
          const nearest = Math.min(Infinity, ...bad.map(([x, y]) => ground(a, b, x, y)));
          // Sampled along the leg: within a twentieth of a cell of the true distance.
          const slack = CELL_M / 4;
          if (known === true && nearest < halfWidth - slack) {
            wrong.push(`passed ${nearest.toFixed(1)} m from land at half-width ${halfWidth}`);
          }
          if (known === true && crossed.length > 0) {
            wrong.push(`passed across a closed cell at half-width ${halfWidth}`);
          }
          if (known === false && nearest > halfWidth + slack) {
            wrong.push(`failed ${nearest.toFixed(1)} m from land at half-width ${halfWidth}`);
          }
        }
      ),
      { numRuns: 400 }
    );
    expect(wrong).toEqual([]);
  });
});
