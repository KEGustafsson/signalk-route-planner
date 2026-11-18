import { parsePlanRequest } from "../../src/api/plan-request";

const NOW = Date.parse("2026-11-18T07:00:00Z");

describe("plan request validation", () => {
  test("accepts start, destination and options", () => {
    expect(
      parsePlanRequest(
        {
          from: [22.1, 60.2],
          to: [22.3, 60.27],
          departure: "2026-11-18T08:00:00Z",
          speed: 3.1,
          xteLimit: 25,
          probability: 0.01,
          draft: 1.9
        },
        NOW
      )
    ).toEqual({
      ok: true,
      value: {
        from: [22.1, 60.2],
        to: [22.3, 60.27],
        departure: Date.parse("2026-11-18T08:00:00Z"),
        speed: 3.1,
        xteLimit: 25,
        probability: 0.01,
        draft: 1.9
      }
    });
    expect(parsePlanRequest({ from: [22, 60], to: [22.1, 60] }, NOW)).toEqual({
      ok: true,
      value: { from: [22, 60], to: [22.1, 60] }
    });
  });

  test.each([
    [null, /give from and to/],
    [[1, 2], /give from and to/],
    [{ to: [22, 60] }, /from must be/],
    [{ from: [22, 60], to: [200, 60] }, /to must be/],
    [{ from: [22, 60], to: [22, 89] }, /to must be/],
    [{ from: [22, 60], to: ["22", 60] }, /to must be/],
    [{ from: [22, 60], to: [22.1, 60], departure: "soon" }, /ISO 8601/],
    [{ from: [22, 60], to: [22.1, 60], departure: "2030-01-01T00:00:00Z" }, /within a year/],
    [{ from: [22, 60], to: [22.1, 60], speed: 0 }, /speed must be 0.1..30 m\/s/],
    [{ from: [22, 60], to: [22.1, 60], xteLimit: -1 }, /xteLimit/],
    [{ from: [22, 60], to: [22.1, 60], probability: 0 }, /probability must be over 0..0.5/],
    [{ from: [22, 60], to: [22.1, 60], probability: 0.6 }, /probability/],
    [{ from: [22, 60], to: [22.1, 60], draft: 31 }, /draft/],
    [{ from: [22, 60], to: [22.1, 60], draft: Number.NaN }, /draft/]
  ])("rejects %j", (body, message) => {
    const r = parsePlanRequest(body, NOW);
    expect(r.ok ? "" : r.errors.join("; ")).toMatch(message);
  });
});
