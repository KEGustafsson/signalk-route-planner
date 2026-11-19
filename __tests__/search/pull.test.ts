import type { LonLat } from "../../src/foundation/geo";
import type { Verdict } from "../../src/oracle/contract";
import { pull } from "../../src/search/pull";

/** String pulling stops at its work limit and says so (plan §4.1, bounded work). */

const OK: Verdict = { status: "ok", risk: 0, flags: [] };
const FAIL: Verdict = { status: "fail", risk: 0.9, flags: [] };
const points: LonLat[] = Array.from({ length: 9 }, (_, i) => [i / 1000, 0]);

describe("string pulling", () => {
  test("a work limit reached between candidates stops it with no further checks", async () => {
    let checks = 0;
    const r = await pull(
      points,
      () => {
        checks++;
        return FAIL;
      },
      { exhausted: () => checks >= 2, pause: () => Promise.resolve() }
    );
    expect(r).toBe("work");
    expect(checks).toBe(2);
  });

  test("within its work, the first passing candidate is the next waypoint", async () => {
    const r = await pull(points, (_a, b) => (b[0] <= 0.0045 ? OK : FAIL), {
      exhausted: () => false,
      pause: () => Promise.resolve()
    });
    expect(r).toEqual([points[0], points[4], points[5], points[6], points[7], points[8]]);
  });
});
