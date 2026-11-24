import type { LonLat } from "../../src/foundation/geo";
import { cutAt, DETOUR, LOOK, lookFrom, priceOf, secondLook } from "../../src/plan/second-look";
import { WORK_LIMIT } from "../../src/plan/search";
import type { Part, Staged } from "../../src/plan/stages";
import { at } from "../helpers/synthetic-oracle";

/**
 * A second look at a route's ends (`plan/second-look.ts`): a stretch near an end that runs far
 * longer than the straight line is planned again as a trip of its own, and the cheaper stands.
 */

const DIRECT: Extract<Staged, { ok: true }>["direct"] = { status: "ok", risk: 0, flags: [] };

const found = (parts: Part[], work = 1000): Extract<Staged, { ok: true }> => ({
  ok: true,
  parts,
  direct: DIRECT,
  work,
  squares: 10
});

/** A route from 10 km east, straight in, then a detour round the north to the destination. */
const detour: Part[] = [
  {
    kind: "route",
    xteLimit: 30,
    coordinates: [at(10_000, 0), at(4_000, 0), at(2_000, 2_000), at(-500, 1_500), at(0, 0)]
  }
];
const straightIn: Part[] = [
  { kind: "route", xteLimit: 30, coordinates: [at(4_000, 0), at(1_000, 0)] },
  { kind: "narrows", xteLimit: 0, coordinates: [at(1_000, 0), at(0, 0)] }
];

describe("a second look at a route's ends", () => {
  test("looks from the last point LOOK metres out, and only where the stretch is a detour", () => {
    const path = detour[0]?.coordinates as LonLat[];
    expect(lookFrom(path, "end")).toEqual(at(4_000, 0));
    // The start's first 4 km run straight.
    expect(lookFrom(path, "start")).toBeUndefined();
    // A stretch no more than DETOUR times the straight line is not looked at.
    const near: LonLat[] = [
      at(10_000, 0),
      at(LOOK, 0),
      at(LOOK / 2, (LOOK * DETOUR) / 4),
      at(0, 0)
    ];
    expect(lookFrom(near, "end")).toBeUndefined();
  });

  test("splices in a cheaper plan of the stretch, from the point it was looked at from", async () => {
    const asked: [LonLat, LonLat][] = [];
    const out = await secondLook(
      found(detour),
      (a, b) => {
        asked.push([a, b]);
        return Promise.resolve(found(straightIn, 500));
      },
      { maxWork: 1_000_000, narrow: 1 }
    );
    expect(asked).toEqual([[at(4_000, 0), at(0, 0)]]);
    if (!out.ok) {
      throw new Error("refused");
    }
    expect(out.parts.map((p) => p.kind)).toEqual(["route", "route", "narrows"]);
    expect(out.parts[0]?.coordinates).toEqual([at(10_000, 0), at(4_000, 0)]);
    expect(out.work).toBe(1500);
    expect(priceOf(out.parts, 1)).toBeLessThan(priceOf(detour, 1));
  });

  test("keeps the route where the stretch planned alone costs more, narrow water priced in", async () => {
    // 4 km straight, all of it narrow: 8 km at weight 1, against the detour's 6.7 km.
    const narrow: Part[] = [
      { kind: "narrows", xteLimit: 0, coordinates: [at(4_000, 0), at(0, 0)] }
    ];
    const out = await secondLook(found(detour), () => Promise.resolve(found(narrow)), {
      maxWork: 1_000_000,
      narrow: 1
    });
    // The route stands; the look's work and squares count.
    expect(out).toEqual({ ...found(detour, 2_000), squares: 20 });
  });

  test("never trades a stretch that passes for one only a fallback finds", async () => {
    const risky: Part[] = [
      { kind: "route", xteLimit: 30, fallback: "no way", coordinates: [at(4_000, 0), at(0, 0)] }
    ];
    const out = await secondLook(found(detour), () => Promise.resolve(found(risky)), {
      maxWork: 1_000_000,
      narrow: 1
    });
    // The route stands; the look's work and squares count.
    expect(out).toEqual({ ...found(detour, 2_000), squares: 20 });
  });

  test("a refusal keeps the route; a provider's failure is the answer; no work left, no look", async () => {
    const refused = await secondLook(
      found(detour),
      () =>
        Promise.resolve({
          ok: false as const,
          refusal: {
            ok: false as const,
            reason: "no way",
            direct: DIRECT,
            squares: 0,
            unverified: 0,
            work: 9
          },
          direct: DIRECT,
          work: 9
        }),
      { maxWork: 1_000_000, narrow: 1 }
    );
    // The route stands, and the look's work counts.
    expect(refused).toEqual(found(detour, 1009));
    const failed = await secondLook(
      found(detour),
      () => Promise.resolve({ ok: false as const, status: 503, error: "building" }),
      { maxWork: 1_000_000, narrow: 1 }
    );
    expect(failed).toEqual({ ok: false, status: 503, error: "building" });
    let asked = 0;
    await secondLook(
      found(detour, 1_000_000),
      () => {
        asked++;
        return Promise.resolve(found(straightIn));
      },
      { maxWork: 1_000_000, narrow: 1 }
    );
    expect(asked).toBe(0);
  });

  test("every look's work counts, a way not taken included, and the next gets what is left", async () => {
    // Detours at both ends: 10 km between, the last 4 km round the north, the first 4 km round
    // the south.
    const both: Part[] = [
      {
        kind: "route",
        xteLimit: 30,
        coordinates: [
          at(14_000, 0),
          at(13_000, -2_000),
          at(10_500, -1_500),
          at(10_000, 0),
          at(4_000, 0),
          at(2_000, 2_000),
          at(-500, 1_500),
          at(0, 0)
        ]
      }
    ];
    const budgets: number[] = [];
    const out = await secondLook(
      found(both, 1_000),
      (a, b, maxWork) => {
        budgets.push(maxWork);
        // Each way costs more than the stretch it would replace, so neither is taken.
        const long: Part[] = [
          { kind: "narrows", xteLimit: 0, coordinates: [a, at(7_000, 9_000), b] }
        ];
        return Promise.resolve(found(long, 900));
      },
      { maxWork: 4_000, narrow: 1 }
    );
    expect(budgets).toEqual([3_000, 2_100]);
    if (!out.ok) {
      throw new Error("refused");
    }
    expect(out.parts).toEqual(both);
    expect(out.work).toBe(2_800);
    expect(out.squares).toBe(30);
  });

  test("a look that runs out of work refuses the plan with the work limit", async () => {
    const out = await secondLook(
      found(detour, 1_000),
      () =>
        Promise.resolve({
          ok: false as const,
          refusal: {
            ok: false as const,
            reason: WORK_LIMIT,
            direct: DIRECT,
            squares: 4,
            unverified: 0,
            work: 500
          },
          direct: DIRECT,
          work: 500
        }),
      { maxWork: 1_500, narrow: 1 }
    );
    expect(out).toMatchObject({
      ok: false,
      refusal: { reason: WORK_LIMIT, work: 1_500, squares: 14 },
      work: 1_500
    });
  });

  test("a look that finds its way with the work past the limit refuses the plan", async () => {
    // The checks after a search may take its work past what it was given.
    const out = await secondLook(
      found(detour, 1_000),
      () => Promise.resolve(found(straightIn, 600)),
      {
        maxWork: 1_500,
        narrow: 1
      }
    );
    expect(out).toMatchObject({
      ok: false,
      refusal: { reason: WORK_LIMIT, work: 1_600, squares: 20 },
      work: 1_600
    });
  });

  test("cuts parts at a vertex of theirs", () => {
    const parts: Part[] = [
      { kind: "route", coordinates: [at(0, 0), at(100, 0), at(200, 0)] },
      { kind: "narrows", coordinates: [at(200, 0), at(300, 0)] }
    ];
    expect(cutAt(parts, at(100, 0))).toEqual([
      [{ kind: "route", coordinates: [at(0, 0), at(100, 0)] }],
      [
        { kind: "route", coordinates: [at(100, 0), at(200, 0)] },
        { kind: "narrows", coordinates: [at(200, 0), at(300, 0)] }
      ]
    ]);
    expect(cutAt(parts, at(200, 0))).toEqual([
      [{ kind: "route", coordinates: [at(0, 0), at(100, 0), at(200, 0)] }],
      [{ kind: "narrows", coordinates: [at(200, 0), at(300, 0)] }]
    ]);
  });
});
