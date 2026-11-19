import P = require("../../public/planner-shared.js");

/** What the panel computes from a host route and a /plan reply. */

describe("panel model", () => {
  test("the ends of a route are its first and last points with positions", () => {
    expect(
      P.endsOf([{ position: [22, 60] }, { position: [22.1, 60.1] }, { position: [22.2, 60.2] }])
    ).toEqual({
      from: [22, 60],
      to: [22.2, 60.2]
    });
    expect(P.endsOf([{ position: [22, 60] }])).toBeNull();
    expect(P.endsOf(undefined)).toBeNull();
  });

  test("the plan keeps the names and waypoint links of the route's own ends", () => {
    const original = [
      { position: [22, 60], name: "Home", href: "/resources/waypoints/a" },
      { position: [22.1, 60.1], name: "old middle" },
      { position: [22.2, 60.2], name: "Harbour" }
    ];
    expect(
      P.planPoints(
        [
          [22, 60],
          [22.15, 60.05],
          [22.2, 60.2]
        ],
        original
      )
    ).toEqual([
      { position: [22, 60], name: "Home", href: "/resources/waypoints/a" },
      { position: [22.15, 60.05] },
      { position: [22.2, 60.2], name: "Harbour" }
    ]);
  });

  test("one line for each kind of reply", () => {
    expect(P.summary(200, { status: "ok", length: 5556, check: { legs: [{}, {}] } })).toEqual({
      kind: "ok",
      text: "Planned 3.0 nm in 2 legs: ok"
    });
    expect(P.summary(200, { status: "marginal", length: 1852, check: { legs: [{}] } }).text).toBe(
      "Planned 1.0 nm in 1 leg: marginal (see the legs below)"
    );
    expect(
      P.summary(200, {
        status: "fail",
        length: 1852,
        check: { legs: [{}] },
        fallback: "no route the check passes connects the points"
      }).text
    ).toBe(
      "Planned 1.0 nm in 1 leg: fail (see the legs below). No route passes the check: this is the lowest risk-weighted route, no route the check passes connects the points"
    );
    expect(
      P.summary(200, {
        status: "fail",
        underway: "ok",
        length: 3704,
        berths: [{ end: "start", leg: 0, length: 12 }],
        check: { legs: [{}, {}, {}] }
      }).text
    ).toBe(
      "Planned 2.0 nm in 3 legs: fail (see the legs below). Underway ok; a berth leg lies alongside the quay, inside the corridor: steer it by eye"
    );
    expect(
      P.summary(200, {
        status: "ok",
        length: 1852,
        check: { legs: [{}] },
        gate: { departure: "2026-11-18T13:15:00.000Z", waitMinutes: 375 }
      }).text
    ).toBe("Leave at 13:15 UTC, waiting 6 h 15 min for the tide. Planned 1.0 nm in 1 leg: ok");
    // A fallback reply whose wait found no departure says so, with its marked route.
    expect(
      P.summary(200, {
        status: "fail",
        length: 1852,
        check: { legs: [{}] },
        fallback: "no route passes",
        gate: { reason: "no departure up to 12:00 passes leg 2" }
      }).text
    ).toMatch(
      /^Waiting for the tide found no passing route: no departure up to 12:00 passes leg 2\. Planned/
    );
    expect(
      P.summary(422, {
        reason: "no route",
        gate: { reason: "no departure up to 12:00 passes leg 2" }
      }).text
    ).toBe("No route: no route; no departure up to 12:00 passes leg 2");
    expect(P.legLabel({ status: "fail", part: "harbour", berth: true })).toBe("fail (berth)");
    expect(P.legLabel({ status: "ok", part: "harbour" })).toBe("ok (harbour)");
    expect(P.legLabel({ status: "ok", part: "route" })).toBe("ok");
    expect(P.summary(422, { reason: "land, shoals or obstacles close every way" })).toEqual({
      kind: "fail",
      text: "No route: land, shoals or obstacles close every way"
    });
    expect(P.summary(503, { errors: ["building the chart box"] })).toEqual({
      kind: "unverified",
      text: "Not planned: building the chart box"
    });
    expect(P.summary(500, undefined).text).toBe("Not planned: the planner did not answer");
  });
});
