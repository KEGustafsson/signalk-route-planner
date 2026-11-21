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
    // Each wait on the way, after the departure's.
    expect(
      P.summary(200, {
        status: "ok",
        length: 1852,
        check: { legs: [{}, {}] },
        gate: {
          departure: "2026-11-18T08:45:00.000Z",
          waitMinutes: 105,
          waits: [{ at: [22.04248, 59.99793], arrive: "2026-11-18T09:11:31.728Z", minutes: 678 }]
        }
      }).text
    ).toBe(
      "Leave at 08:45 UTC, waiting 1 h 45 min for the tide; then wait 11 h 18 min from 09:11 UTC at 59.9979, 22.0425. Planned 1.0 nm in 2 legs: ok"
    );
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

  test("while the trip's chart index is built the panel waits as asked, and says so", () => {
    const building = { errors: ["building"], preparing: true };
    expect(P.preparingWait(503, building, "45")).toBe(45);
    expect(P.preparingWait(503, building, null)).toBe(30);
    expect(P.preparingWait(503, building, "9999")).toBe(300);
    expect(P.preparingWait(503, { errors: ["no index"] }, "30")).toBeNull();
    expect(P.preparingWait(200, building, "30")).toBeNull();
    expect(P.summary(503, building)).toEqual({
      kind: "muted",
      text: expect.stringMatching(/^Building the chart index for this trip's region/)
    });
    expect(P.MAX_PREPARING).toBeGreaterThan(0);
  });

  test("a route is written only when its points are as they were read", () => {
    const pts = [{ position: [22, 60] }, { position: [22.1, 60.1], name: "x" }];
    expect(P.samePoints(pts, [{ position: [22, 60] }, { position: [22.1, 60.1] }])).toBe(true);
    expect(P.samePoints(pts, [{ position: [22, 60] }, { position: [22.2, 60.1] }])).toBe(false);
    expect(P.samePoints(pts, [{ position: [22, 60] }])).toBe(false);
    expect(P.samePoints(pts, undefined)).toBe(false);
  });

  test("a single dragged waypoint is found; any other change is not one", () => {
    const pts = [{ position: [22, 60] }, { position: [22.1, 60.1] }, { position: [22.2, 60.2] }];
    const moved = [pts[0], { position: [22.12, 60.1] }, pts[2]];
    expect(P.movedPoint(pts, moved)).toBe(1);
    expect(P.movedPoint(pts, pts)).toBe(-1);
    expect(P.movedPoint(pts, [pts[0], pts[2]])).toBe(-1);
    expect(P.movedPoint(pts, [{ position: [21, 60] }, moved[1], pts[2]])).toBe(-1);
    expect(P.movedPoint(pts, undefined)).toBe(-1);
  });

  test("the legs beside a dragged waypoint are spliced in, every other point kept", () => {
    const pts = [
      { position: [22, 60], name: "Home" },
      { position: [22.1, 60.1] },
      { position: [22.12, 60.1], name: "Moved" },
      { position: [22.3, 60.3], name: "Harbour" }
    ];
    const left: [number, number][] = [
      [22.1, 60.1],
      [22.11, 60.12],
      [22.12, 60.1]
    ];
    const right: [number, number][] = [
      [22.12, 60.1],
      [22.2, 60.15],
      [22.3, 60.3]
    ];
    expect(P.spliceLegs(pts, 2, left, right)).toEqual([
      pts[0],
      pts[1],
      { position: [22.11, 60.12] },
      pts[2],
      { position: [22.2, 60.15] },
      pts[3]
    ]);
    // An end point has a leg on one side only.
    expect(
      P.spliceLegs(
        pts,
        0,
        [],
        [
          [22, 60],
          [22.05, 60.02],
          [22.1, 60.1]
        ]
      )
    ).toEqual([pts[0], { position: [22.05, 60.02] }, pts[1], pts[2], pts[3]]);
  });

  test("a leg's flags in words, alternatives in one line each, and the map's lines", () => {
    expect(P.legNote({ flags: ["AIR_DRAFT", "SWEPT"] })).toBe(
      "a bridge or overhead cable too low for the mast; swept"
    );
    expect(P.legNote({ flags: ["SOMETHING_NEW"] })).toBe("SOMETHING_NEW");
    expect(P.legNote({})).toBe("");
    const shortest = {
      name: "shortest",
      length: 1852,
      risk: 0.0123,
      status: "ok",
      route: {
        type: "LineString",
        coordinates: [
          [22, 60],
          [22.1, 60]
        ]
      }
    };
    const safest = { ...shortest, name: "safest", dominatedBy: "shortest" };
    const balanced = { ...shortest, name: "balanced", sameAs: "shortest" };
    expect(P.alternativeText(shortest)).toBe("shortest: 1.0 nm, risk 1.23 %, ok");
    expect(P.alternativeText(safest)).toMatch(/no safer than shortest$/);
    expect(P.alternativeText({ name: "safest", reason: "over the budget" })).toBe(
      "safest: not offered, over the budget"
    );
    const map = P.alternativesGeoJSON([shortest, balanced, safest], "shortest");
    const props = map.features.map((f: { properties: { name: string; chosen: boolean } }) => [
      f.properties.name,
      f.properties.chosen
    ]);
    expect(props).toEqual([
      ["shortest", true],
      ["safest", false]
    ]);
  });

  test("the start is the boat's position when it is known", () => {
    const ends = { from: [22, 60] as [number, number], to: [22.2, 60.2] as [number, number] };
    expect(P.fromBoat(ends, { longitude: 21.9, latitude: 59.9 })).toEqual({
      from: [21.9, 59.9],
      to: [22.2, 60.2]
    });
    expect(P.fromBoat(ends, undefined)).toEqual(ends);
    expect(P.fromBoat(null, { longitude: 21.9, latitude: 59.9 })).toBeNull();
  });

  test("a boat position is known only with a finite longitude and latitude", () => {
    expect(P.hasPosition({ longitude: 21.9, latitude: 59.9 })).toBe(true);
    expect(P.hasPosition(undefined)).toBe(false);
    expect(P.hasPosition({ longitude: Number.NaN, latitude: 59.9 })).toBe(false);
    expect(P.hasPosition({ latitude: 59.9 })).toBe(false);
    expect(P.hasPosition({ longitude: null, latitude: null })).toBe(false);
    expect(P.hasPosition({ longitude: "21.9", latitude: "59.9" })).toBe(false);
  });

  test("the worst of check statuses, ok for none", () => {
    expect(P.worstStatus([])).toBe("ok");
    expect(P.worstStatus(["ok", "marginal"])).toBe("marginal");
    expect(P.worstStatus(["marginal", "unverified", "ok"])).toBe("unverified");
    expect(P.worstStatus(["fail", "unverified"])).toBe("fail");
    // A status this panel does not know is never read as passing.
    expect(P.worstStatus(["ok", "something new"])).toBe("something new");
    expect(P.worstStatus(["something new", "fail"])).toBe("fail");
    expect(P.worstStatus(["constructor"])).toBe("constructor");
    expect(P.worstStatus(["ok", "toString", "marginal"])).toBe("toString");
    expect(P.worstStatus(["something new", "marginal"])).toBe("something new");
  });
});
