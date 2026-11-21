import type { LonLat } from "../../src/foundation/geo";
import type {
  Bbox,
  PlanningApiV1,
  Prepared,
  PrepareResult,
  Survey,
  SurveyResult
} from "../../src/oracle/contract";
import { mosaic, surveyRegion, surveyTiles } from "../../src/plan/corridor";
import { Preparer } from "../../src/plan/prepare";
import { syntheticApi } from "../helpers/synthetic-oracle";

/**
 * The depth survey along a long trip (plan §4.2): signalk-underkeel caps a survey's area, so a
 * diagonal trip whose box is over the cap is surveyed in pieces along its line and joined.
 */

const M_PER_DEG = 111_195;
const CELL = 500;

const km2 = (b: Bbox): number =>
  (((b[2] - b[0]) * Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180) * M_PER_DEG) / 1000) *
  (((b[3] - b[1]) * M_PER_DEG) / 1000);

/** A survey of `region` at CELL, each cell `depth` at its centre. */
function surveyOf(region: Bbox, depth: (p: LonLat) => number, cell = CELL): Survey {
  const mid = ((region[1] + region[3]) / 2) * (Math.PI / 180);
  const dLat = cell / M_PER_DEG;
  const dLon = cell / (M_PER_DEG * Math.cos(mid));
  const cols = Math.ceil((region[2] - region[0]) / dLon);
  const rows = Math.ceil((region[3] - region[1]) / dLat);
  const d = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      d[r * cols + c] = depth([region[0] + (c + 0.5) * dLon, region[1] + (r + 0.5) * dLat]);
    }
  }
  return {
    bbox: [region[0], region[1], region[0] + cols * dLon, region[1] + rows * dLat],
    cols,
    rows,
    cellMetres: cell,
    depth: d,
    shallowest: d
  };
}

describe("survey tiles", () => {
  const from: LonLat = [21.0, 59.6];
  const to: LonLat = [23.2, 60.6];

  test("each piece's box holds its stretch of the line with the trip's reach, and less than the whole", () => {
    const whole = surveyRegion(from, to);
    const tiles = surveyTiles(from, to, 3);
    expect(tiles).toHaveLength(3);
    for (const t of tiles) {
      expect(km2(t)).toBeLessThan(km2(whole) / 2);
    }
    // Neighbours overlap, and the first and last hold the ends with the whole's reach.
    expect(tiles[0]?.[2]).toBeGreaterThan(tiles[1]?.[0] as number);
    expect(tiles[0]?.[0]).toBeCloseTo(whole[0], 1);
    expect(tiles[2]?.[3]).toBeCloseTo(whole[3], 1);
  });

  test("a mosaic is as deep as the deepest tile over a cell and as sure as the least sure", () => {
    const a = surveyOf([22, 60, 22.2, 60.1], () => 5);
    const b = surveyOf([22.1, 60, 22.3, 60.1], () => 9);
    const least = { ...b, shallowest: new Float32Array(b.cols * b.rows).fill(1) };
    const m = mosaic([a, least]);
    const cell = (lon: number): number => {
      const dLon = (m.bbox[2] - m.bbox[0]) / m.cols;
      return Math.floor((lon - m.bbox[0]) / dLon);
    };
    const row = Math.floor(m.rows / 2) * m.cols;
    expect(m.depth[row + cell(22.05)]).toBe(5);
    expect(m.depth[row + cell(22.15)]).toBe(9);
    expect(m.depth[row + cell(22.25)]).toBe(9);
    expect(m.shallowest?.[row + cell(22.05)]).toBe(5);
    expect(m.shallowest?.[row + cell(22.15)]).toBe(1);
    // One grid is itself.
    expect(mosaic([a])).toBe(a);
  });

  test("a mosaic cell over a finer tile takes every cell it touches, not only its centre's", () => {
    const fineCell = 100;
    const dLonFine = fineCell / (M_PER_DEG * Math.cos((60.05 * Math.PI) / 180));
    const column = (p: LonLat): number => Math.floor((p[0] - 22) / dLonFine);
    const fine = surveyOf([22, 60, 22.1, 60.1], (p) => (column(p) % 2 === 0 ? 8 : 1), fineCell);
    const gappy = surveyOf([22, 60, 22.1, 60.1], (p) => (column(p) % 3 === 1 ? NaN : 8), fineCell);
    const coarse = surveyOf([22.1, 60, 22.2, 60.1], () => 9);
    const m = mosaic([fine, coarse]);
    const g = mosaic([gappy, coarse]);
    const inner = (s: Survey): number[] => {
      const out: number[] = [];
      for (let c = 1; c < s.cols - 1; c++) {
        const lon = s.bbox[0] + ((c + 0.5) * (s.bbox[2] - s.bbox[0])) / s.cols;
        if (lon < 22.09) {
          out.push(Math.floor(s.rows / 2) * s.cols + c);
        }
      }
      return out;
    };
    expect(m.cellMetres).toBe(CELL);
    for (const i of inner(m)) {
      expect(m.depth[i]).toBe(8);
      expect(m.shallowest?.[i]).toBe(1);
    }
    // A cell touching one with no charted depth keeps the deepest, but is not sure all over.
    for (const i of inner(g)) {
      expect(g.depth[i]).toBe(8);
      expect(g.shallowest?.[i]).toBeNaN();
    }
  });

  test("a mosaic cell no tile holds whole keeps its depth but is not sure all over", () => {
    const dLat = CELL / M_PER_DEG;
    const dLon = CELL / (M_PER_DEG * Math.cos(((60 + dLat) * Math.PI) / 180));
    const twoByTwo = (west: number): Survey => {
      const depth = new Float32Array(4).fill(9);
      return {
        bbox: [west, 60, west + 2 * dLon, 60 + 2 * dLat],
        cols: 2,
        rows: 2,
        cellMetres: CELL,
        depth,
        shallowest: depth
      };
    };
    const a = twoByTwo(22);
    const b = twoByTwo(22 + 1.5 * dLon);
    const m = mosaic([a, b]);
    const at = (lon: number): number =>
      Math.floor(((lon - m.bbox[0]) / (m.bbox[2] - m.bbox[0])) * m.cols);
    const partial = at(22 + 3.25 * dLon);
    expect(m.depth[partial]).toBe(9);
    expect(m.shallowest?.[partial]).toBeNaN();
    // Cells a tile holds whole stay sure.
    expect(m.shallowest?.[at(22 + 0.5 * dLon)]).toBe(9);
    expect(m.shallowest?.[at(22 + 2.5 * dLon)]).toBe(9);
  });

  test("a trip whose survey is over the cap is surveyed in pieces, and its corridor prepared", async () => {
    const cap = 6000;
    const surveys: Bbox[] = [];
    const corridors: (readonly Bbox[])[] = [];
    const inner = syntheticApi({ obstacles: [] });
    const prepared: Prepared = {
      coverage: undefined,
      session: (p, s, job) => inner.session(p, s, job),
      routeCheck: (b, s) => inner.routeCheck(b, s),
      release: () => undefined
    };
    const api: PlanningApiV1 = {
      ...inner,
      features: ["prepare", "corridor", "survey"],
      prepare: (_region, _signal, corridor) => {
        if (corridor) {
          corridors.push(corridor);
        }
        return Promise.resolve<PrepareResult>(
          corridor ? { ok: true, value: prepared } : { ok: false, status: 413, error: "too large" }
        );
      },
      survey: (region: Bbox): Promise<SurveyResult> => {
        surveys.push(region);
        return Promise.resolve(
          km2(region) > cap
            ? { ok: false, status: 413, error: `${Math.round(km2(region))} km²` }
            : { ok: true, value: surveyOf(region, () => 8) }
        );
      }
    };
    expect(km2(surveyRegion(from, to))).toBeGreaterThan(cap);
    const r = await new Preparer(1000).forTrip(api, from, to, new AbortController().signal, 1.8);
    expect("version" in r).toBe(true);
    expect(surveys[0]).toEqual(surveyRegion(from, to));
    const pieces = surveys.slice(1).filter((b) => km2(b) <= cap);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    expect(corridors).toHaveLength(1);
    // The corridor runs the whole way: its boxes hold both ends.
    const holds = (p: LonLat) =>
      corridors[0]?.some((b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]);
    expect(holds(from) && holds(to)).toBe(true);
  });

  test("a survey refused for another reason is not tried in pieces", async () => {
    const surveys: Bbox[] = [];
    const inner = syntheticApi({ obstacles: [] });
    const api: PlanningApiV1 = {
      ...inner,
      features: ["prepare", "corridor", "survey"],
      prepare: () => Promise.resolve<PrepareResult>({ ok: false, status: 413, error: "too large" }),
      survey: (region: Bbox): Promise<SurveyResult> => {
        surveys.push(region);
        return Promise.resolve({ ok: false, status: 503, error: "down" });
      }
    };
    const r = await new Preparer(1000).forTrip(api, from, to, new AbortController().signal, 1.8);
    expect("version" in r).toBe(false);
    expect(surveys).toHaveLength(1);
  });
});
