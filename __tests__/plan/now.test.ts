import type { Staged } from "../../src/plan/stages";
import { stages } from "../../src/plan/stages";
import { WORK_LIMIT } from "../../src/plan/search";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { nowStages } from "../../src/plan/now";

/**
 * The searches at the boat's own timing after a fallback route (plan §4.3, R3d): a fallback is
 * the last resort, so a strict search cut short answers with its reason, never the fallback.
 */

jest.mock("../../src/plan/stages", () => ({ stages: jest.fn() }));
// Some water the first search met could pass at another time.
jest.mock("../../src/plan/timing", () => ({
  ...jest.requireActual<typeof import("../../src/plan/timing")>("../../src/plan/timing"),
  newMet: () => ({ waterBound: 1, known: new Map() })
}));

const staged = stages as jest.MockedFunction<typeof stages>;
const direct = { status: "fail", flags: [] } as unknown as Extract<Staged, { ok: true }>["direct"];
const fallbackRoute: Staged = {
  ok: true,
  parts: [
    {
      kind: "route",
      coordinates: [
        [22, 60],
        [22.05, 60]
      ],
      fallback: "no route passes the check"
    }
  ],
  direct,
  work: 1000,
  squares: 10
};
const strictRoute: Staged = {
  ok: true,
  parts: [
    {
      kind: "route",
      coordinates: [
        [22, 60],
        [22.05, 60]
      ]
    }
  ],
  direct,
  work: 500,
  squares: 5
};
const refused = (reason: string): Staged => ({
  ok: false,
  refusal: { ok: false, reason, direct, squares: 3, unverified: 0, work: 400 },
  direct,
  work: 400
});

const st = {
  api: { version: 1, provider: "stub" },
  opts: { ...DEFAULT_PLAN, maxWork: 1_000_000 },
  fallback: true
} as unknown as Parameters<typeof nowStages>[0];
const trip = {
  from: [22, 60] as [number, number],
  to: [22.05, 60] as [number, number],
  departure: 0,
  speed: 3
};
const HOUR = 3_600_000;

describe("after a fallback route, the searches at the boat's timing", () => {
  beforeEach(() => staged.mockReset());

  test("offer the route that passes at the boat's timing, holding then", async () => {
    staged.mockResolvedValueOnce(fallbackRoute).mockResolvedValueOnce(strictRoute);
    const r = await nowStages(st, trip, HOUR);
    expect(r).toMatchObject({ found: { ok: true }, holds: "now" });
    expect("parts" in r.found && r.found.parts[0]?.fallback).toBeUndefined();
    // The strict search ran with fallback off.
    expect(staged.mock.calls[1]?.[0]).toMatchObject({ fallback: false });
  });

  test("cut short by the work limit, answer with that reason, not the fallback", async () => {
    staged.mockResolvedValueOnce(fallbackRoute).mockResolvedValueOnce(refused(WORK_LIMIT));
    const r = await nowStages(st, trip, HOUR);
    expect("refusal" in r.found && r.found.refusal.reason).toBe(WORK_LIMIT);
  });

  test("failing with an error, answer with the error", async () => {
    staged
      .mockResolvedValueOnce(fallbackRoute)
      .mockResolvedValueOnce({ ok: false, status: 503, error: "underkeel went away" });
    const r = await nowStages(st, trip, HOUR);
    expect(r.found).toMatchObject({ status: 503 });
  });

  test("finding no route, offer the fallback, holding only at its departure", async () => {
    staged.mockResolvedValue(refused("no route passes the check"));
    staged.mockResolvedValueOnce(fallbackRoute);
    const r = await nowStages(st, trip, HOUR);
    expect(r.holds).toBe("now");
    expect("parts" in r.found && r.found.parts[0]?.fallback).toBeDefined();
  });
});
