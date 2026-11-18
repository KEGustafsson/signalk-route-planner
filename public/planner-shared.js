// What the route planner panel computes, kept out of the page so the tests
// can require() it. Plain script: the panel loads it with <script>.
(function (root) {
  "use strict";

  const API = "/plugins/signalk-route-planner/v1";

  /** The start and destination of a host route: its first and last points, or null. */
  function endsOf(points) {
    const coords = (points || [])
      .map(function (p) {
        return p && p.position ? [p.position[0], p.position[1]] : null;
      })
      .filter(function (c) {
        return c && isFinite(c[0]) && isFinite(c[1]);
      });
    return coords.length < 2 ? null : { from: coords[0], to: coords[coords.length - 1] };
  }

  /**
   * The planned line as host route points. The first and last keep the names
   * and waypoint links of the route's own ends; the points between are new.
   */
  function planPoints(coordinates, original) {
    const first = (original || [])[0] || {};
    const last = (original || [])[(original || []).length - 1] || {};
    return coordinates.map(function (c, i) {
      const end = i === 0 ? first : i === coordinates.length - 1 ? last : null;
      const p = { position: [c[0], c[1]] };
      if (end && end.name) {
        p.name = end.name;
      }
      if (end && end.href) {
        p.href = end.href;
      }
      return p;
    });
  }

  /** Metres as nautical miles with one decimal. */
  function nm(metres) {
    return (metres / 1852).toFixed(1) + " nm";
  }

  /** One line for the panel from a `/plan` reply (status code and body). */
  function summary(status, body) {
    const b = body || {};
    if (status === 200) {
      const legs = (b.check && b.check.legs) || [];
      return {
        kind: b.status,
        text:
          "Planned " +
          nm(b.length || 0) +
          " in " +
          legs.length +
          (legs.length === 1 ? " leg" : " legs") +
          ": " +
          b.status +
          (b.status === "ok" ? "" : " (see the legs below)") +
          (b.fallback ? ". No route passes the check: this is the least risky one, " + b.fallback : "")
      };
    }
    if (status === 422) {
      return { kind: "fail", text: "No route: " + (b.reason || "no route found") };
    }
    const errors = Array.isArray(b.errors) ? b.errors.join("; ") : "the planner did not answer";
    return { kind: "unverified", text: "Not planned: " + errors };
  }

  const api = { API: API, endsOf: endsOf, planPoints: planPoints, nm: nm, summary: summary };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PLANNER = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
