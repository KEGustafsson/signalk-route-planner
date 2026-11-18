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
