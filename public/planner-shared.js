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

  /** A leg's status for the leg table, with its part when it is not the open route. */
  function legLabel(leg) {
    const l = leg || {};
    return l.berth ? l.status + " (berth)" : l.part === "harbour" ? l.status + " (harbour)" : l.status;
  }

  /** Metres as nautical miles with one decimal. */
  function nm(metres) {
    return (metres / 1852).toFixed(1) + " nm";
  }

  /** Minutes as "3 h 15 min" or "40 min". */
  function duration(m) {
    return m >= 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : m + " min";
  }

  /**
   * "Leave at 14:15 UTC, waiting 3 h 15 min for the tide. " for a tide-gated plan, with each
   * wait on the way after it; why waiting found no departure when it did not (a fallback reply
   * still offers its marked route); else "".
   */
  function gateText(gate) {
    if (gate && gate.reason) {
      return "Waiting for the tide found no passing route: " + gate.reason + ". ";
    }
    if (!gate || !gate.departure) {
      return "";
    }
    const leave = "Leave at " + gate.departure.slice(11, 16) + " UTC, waiting ";
    const on = (gate.waits || []).map(
      (w) =>
        "wait " +
        duration(w.minutes) +
        " from " +
        w.arrive.slice(11, 16) +
        " UTC at " +
        w.at[1].toFixed(4) +
        ", " +
        w.at[0].toFixed(4)
    );
    const then = on.length > 0 ? "; then " + on.join("; then ") : "";
    return leave + duration(gate.waitMinutes || 0) + " for the tide" + then + ". ";
  }

  /** Whether two lists of host route points have the same positions, in order. */
  function samePoints(a, b) {
    const pa = a || [];
    const pb = b || [];
    return (
      pa.length === pb.length &&
      pa.every(function (p, i) {
        const q = pb[i];
        const x = p && p.position;
        const y = q && q.position;
        return !!x && !!y && x[0] === y[0] && x[1] === y[1];
      })
    );
  }

  /** A panel plans again this many times at most while the trip's chart index is built. */
  const MAX_PREPARING = 60;

  /** Seconds to wait before planning again while the chart index is built, else null. */
  function preparingWait(status, body, retryAfter) {
    if (status !== 503 || !body || body.preparing !== true) {
      return null;
    }
    const s = Number(retryAfter);
    return isFinite(s) && s > 0 ? Math.min(s, 300) : 30;
  }

  /** One line for the panel from a `/plan` reply (status code and body). */
  function summary(status, body) {
    const b = body || {};
    if (status === 503 && b.preparing === true) {
      return {
        kind: "muted",
        text:
          "Building the chart index for this trip's region in signalk-underkeel; this can take minutes. Planning again shortly…"
      };
    }
    if (status === 200) {
      const legs = (b.check && b.check.legs) || [];
      return {
        kind: b.status,
        text:
          gateText(b.gate) +
          "Planned " +
          nm(b.length || 0) +
          " in " +
          legs.length +
          (legs.length === 1 ? " leg" : " legs") +
          ": " +
          b.status +
          (b.status === "ok" ? "" : " (see the legs below)") +
          (b.berths && b.berths.length
            ? ". Underway " +
              b.underway +
              "; " +
              (b.berths.length === 1 ? "a berth leg lies" : "berth legs lie") +
              " alongside the quay, inside the corridor: steer " +
              (b.berths.length === 1 ? "it" : "them") +
              " by eye"
            : "") +
          (b.fallback ? ". No route passes the check: this is the lowest risk-weighted route, " + b.fallback : "") +
          (b.timing && b.timing.holds === "now"
            ? ". Passable at your speed leaving now: the tide closes it later, so plan again if you leave later"
            : "")
      };
    }
    if (status === 422) {
      const gate = b.gate && b.gate.reason ? "; " + b.gate.reason : "";
      return { kind: "fail", text: "No route: " + (b.reason || "no route found") + gate };
    }
    const errors = Array.isArray(b.errors) ? b.errors.join("; ") : "the planner did not answer";
    return { kind: "unverified", text: "Not planned: " + errors };
  }

  /**
   * The one point of a route that moved, its index, when `after` is `before` with a single
   * point dragged: the same length, every other position the same. Else -1.
   */
  function movedPoint(before, after) {
    const a = before || [];
    const b = after || [];
    if (a.length !== b.length || a.length < 2) {
      return -1;
    }
    let moved = -1;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] && a[i].position;
      const y = b[i] && b[i].position;
      if (!x || !y) {
        return -1;
      }
      if (x[0] !== y[0] || x[1] !== y[1]) {
        if (moved !== -1) {
          return -1;
        }
        moved = i;
      }
    }
    return moved;
  }

  /**
   * The route with point `i` kept where it was dragged and the legs on either side of it
   * replaced by `left` (from point i - 1 to it) and `right` (from it to point i + 1), each a
   * planned line of coordinates; an end point has only the leg on its one side. Every point
   * the plan did not move keeps its name and link.
   */
  function spliceLegs(points, i, left, right) {
    const between = function (line) {
      return (line || []).slice(1, -1).map(function (c) {
        return { position: [c[0], c[1]] };
      });
    };
    const before = i > 0 ? points.slice(0, i).concat(between(left)) : [];
    const after = i < points.length - 1 ? between(right).concat(points.slice(i + 1)) : [];
    return before.concat([points[i]], after);
  }

  /** What each flag the route check gives a leg says, for the leg table. */
  const FLAG_NOTES = {
    LAND: "touches land",
    AIR_DRAFT: "a bridge or overhead cable too low for the mast",
    CLEARANCE_UNKNOWN: "a bridge or cable whose clearance is not known",
    CLEARANCE_RISE_ASSUMED: "a bridge passed on an assumed rise of the water",
    ENTRY_PROHIBITED: "an area entry is prohibited in",
    TSS_WRONG_WAY: "a traffic lane against its direction",
    TRAFFIC_LANE: "a traffic lane",
    ENTRY_RESTRICTED: "an area entry is restricted in",
    AREA_TO_BE_AVOIDED: "an area to be avoided",
    NO_COVERAGE: "no chart coverage",
    UNASSESSED: "unassessed survey",
    NOT_FOR_NAVIGATION: "depth data not for navigation",
    DREDGED: "dredged",
    SWEPT: "swept",
    WATER_LEVEL_FALLBACK: "no current water level"
  };

  /** A leg's flags in words, joined; "" without any. */
  function legNote(leg) {
    const flags = (leg && leg.flags) || [];
    return flags
      .map(function (f) {
        return FLAG_NOTES[f] || f;
      })
      .join("; ");
  }

  /** One line for an alternative of a `/plan` reply with `alternatives`. */
  function alternativeText(a) {
    if (!a) {
      return "";
    }
    if (a.reason) {
      return a.name + ": not offered, " + a.reason;
    }
    const tail = a.sameAs
      ? ", the same as " + a.sameAs
      : a.dominatedBy
        ? ", no safer than " + a.dominatedBy
        : "";
    return a.name + ": " + nm(a.length) + ", risk " + (a.risk * 100).toFixed(2) + " %, " + a.status + tail;
  }

  /** The offered alternatives as an overlay's GeoJSON, `chosen` marked, the repeats left out. */
  function alternativesGeoJSON(alternatives, chosen) {
    return {
      type: "FeatureCollection",
      features: (alternatives || [])
        .filter(function (a) {
          return a && a.route && !a.sameAs;
        })
        .map(function (a) {
          return {
            type: "Feature",
            geometry: a.route,
            properties: { name: a.name, status: a.status, chosen: a.name === chosen }
          };
        })
    };
  }

  /** Whether `position` is a known one: a longitude and a latitude, both finite. */
  function hasPosition(position) {
    return (
      Boolean(position) && Number.isFinite(position.longitude) && Number.isFinite(position.latitude)
    );
  }

  /** The worst of check statuses, `ok` when there are none. */
  function worstStatus(statuses) {
    const rank = { ok: 0, marginal: 1, unverified: 2, fail: 3 };
    // A status the panel does not know is taken as unverified.
    const of = function (s) {
      return Object.prototype.hasOwnProperty.call(rank, s) ? rank[s] : rank.unverified;
    };
    return statuses.reduce(function (worst, s) {
      return of(s) > of(worst) ? s : worst;
    }, "ok");
  }

  /**
   * The credits the routes' replies name (`attributions`), each source once, in the order they
   * first appear: what the route on the chart leaned on, however many plans made it.
   */
  function credits() {
    const seen = {};
    const out = [];
    Array.prototype.slice.call(arguments).forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (a) {
        if (a && typeof a.text === "string" && !Object.prototype.hasOwnProperty.call(seen, a.source)) {
          seen[a.source] = true;
          out.push(a);
        }
      });
    });
    return out;
  }

  /**
   * The order of the panel's writes to the route: each takes a ticket when it writes and reports
   * its completion; a completed write's leg table, choices and credits are shown only when no
   * write issued after it has completed first. A write that fails, or a plan that writes nothing,
   * leaves the last completed route's own shown.
   */
  function writes() {
    let issued = 0;
    let completed = 0;
    return {
      take: function () {
        return ++issued;
      },
      done: function (ticket) {
        if (ticket <= completed) {
          return false;
        }
        completed = ticket;
        return true;
      }
    };
  }

  /** The trip's ends with the start at the boat's position, when it is known. */
  function fromBoat(ends, position) {
    if (!ends) {
      return null;
    }
    const p = position && [position.longitude, position.latitude];
    return p && isFinite(p[0]) && isFinite(p[1]) ? { from: p, to: ends.to } : ends;
  }

  const api = {
    API: API,
    movedPoint: movedPoint,
    spliceLegs: spliceLegs,
    legNote: legNote,
    alternativeText: alternativeText,
    alternativesGeoJSON: alternativesGeoJSON,
    fromBoat: fromBoat,
    hasPosition: hasPosition,
    worstStatus: worstStatus,
    credits: credits,
    writes: writes,
    endsOf: endsOf,
    planPoints: planPoints,
    nm: nm,
    summary: summary,
    preparingWait: preparingWait,
    samePoints: samePoints,
    MAX_PREPARING: MAX_PREPARING,
    legLabel: legLabel
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PLANNER = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
