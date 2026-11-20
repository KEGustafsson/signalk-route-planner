import { frameAt } from "../../src/foundation/geo";
import type { Session } from "../../src/oracle/contract";
import { lineDistance, preferredIn } from "../../src/search/prefer";
import { QuadTree } from "../../src/search/quadtree";
import { at, syntheticApi } from "../helpers/synthetic-oracle";

/** Preference lines in a tree's units: the starboard side and the clipped grid (plan §4.4). */

const session: Session = {
  halfWidth: 10,
  box: () => ({ status: "ok", risk: 0, flags: [] }),
  segment: () => ({ status: "ok", risk: 0, flags: [] }),
  work: () => 0,
  pause: () => Promise.resolve()
};

/** A 1280 m square of 10 m units with its south-west corner at the synthetic oracle's origin. */
const tree = new QuadTree(
  { frame: frameAt(at(0, 0)), x0: 0, y0: 0, unit: 10, side: 128, maxLeaf: 128 },
  session
);

const HOW = { reachMetres: 50, weight: 0.15, starboardMetres: 15, cellMetres: 80 };

describe("preference lines in the tree", () => {
  test("a fairway winding back on itself keeps the same side through its bends", () => {
    // East along y = 300 m, north, then back west along y = 600 m. The trip goes east, and the
    // boat sails the fairway from its start on, so the westward section's starboard side is
    // north of it, though that section runs against the trip.
    const fairway = {
      coordinates: [at(100, 300), at(1100, 300), at(1100, 600), at(100, 600)],
      twoWay: true
    };
    const pref = preferredIn(tree, [fairway], [at(0, 300), at(1200, 700)], HOW);
    const lines = pref?.lines ?? [];
    // Three sections, each moved whole: two points each.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(6);
    const west = (lines[0] ?? []).slice(4, 6);
    // The section along y = 600 m (60 units), moved 1.5 units: north of it, sailed westwards.
    expect(west.every(([, y]) => y > 60)).toBe(true);
    const east = (lines[0] ?? []).slice(0, 2);
    expect(east.every(([, y]) => y < 30)).toBe(true);
  });

  test("a fairway across the trip is sailed from its end nearer the trip's start", () => {
    // North to south at x = 600 m, crossing an eastward trip that starts by its south end: the
    // boat sails it northwards, so its starboard side is east of it.
    const fairway = { coordinates: [at(600, 1000), at(600, 0)], twoWay: true };
    const pref = preferredIn(tree, [fairway], [at(500, -50), at(1500, -50)], HOW);
    const line = pref?.lines[0] ?? [];
    expect(line).toHaveLength(2);
    expect(line.every(([x]) => x > 60)).toBe(true);
  });

  test("a line longer than the region is clipped to it, and distances inside it stay", () => {
    const long = { coordinates: [at(-500_000, 640), at(500_000, 640)] };
    const pref = preferredIn(tree, [long], [at(0, 0), at(1200, 0)], HOW);
    expect(pref?.segments).toHaveLength(1);
    const [a, b] = (pref?.segments[0] ?? [
      [0, 0],
      [0, 0]
    ]) as [[number, number], [number, number]];
    expect(Math.min(a[0], b[0])).toBeGreaterThanOrEqual(-5);
    expect(Math.max(a[0], b[0])).toBeLessThanOrEqual(128 + 5);
    // A cell per 64 units of the clipped segment, not of the 1000 km line.
    expect(pref?.grid.size).toBeLessThanOrEqual(4);
    expect(lineDistance(pref as NonNullable<typeof pref>, [64, 60], 10)).toBeCloseTo(4, 6);
    // A line wholly outside the region and its reach is none.
    const far = { coordinates: [at(-9000, -9000), at(-8000, -9000)] };
    expect(preferredIn(tree, [far], [at(0, 0), at(1200, 0)], HOW)?.segments).toEqual([]);
  });

  test("the synthetic provider lists a line that crosses the box with no point inside it", async () => {
    const api = syntheticApi(
      {
        obstacles: [],
        lines: [
          {
            class: "NAVLNE",
            points: [
              [-1000, 0],
              [1000, 0]
            ]
          },
          {
            class: "NAVLNE",
            points: [
              [-1000, 500],
              [1000, 500]
            ]
          }
        ]
      },
      { features: ["objects"] }
    );
    const r = await api.session(
      { departure: 0, until: 1000, speed: 3 },
      new AbortController().signal,
      async (s) => s.objects?.(at(-100, -100), at(100, 100)).length
    );
    expect(r).toEqual({ ok: true, value: 1 });
  });
});
