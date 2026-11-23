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
    if (l.berth) {
      return l.status + " (berth)";
    }
    if (l.part === "harbour") {
      return l.status + " (harbour)";
    }
    if (l.part !== "narrows") {
      return l.status;
    }
    // Held to a fairway's line through the gap its swept areas leave under a bridge.
    return Array.isArray(l.flags) && l.flags.includes("FAIRWAY_GAP")
      ? l.status + " (under a bridge, on the fairway line)"
      : l.status + " (narrow, xte " + (l.xteLimit || 0) + " m)";
  }

  /** The sentence for legs through narrows, or "" when there are none. */
  function narrowsText(legs) {
    const narrows = legs.filter((l) => l && l.part === "narrows");
    const n = narrows.length;
    if (n === 0) {
      return "";
    }
    // The route check flags each leg it held to a fairway gap's strip, not each part.
    const p = narrows.filter((l) => Array.isArray(l.flags) && l.flags.includes("FAIRWAY_GAP")).length;
    const which = p === n ? (n === 1 ? "it passes" : "all pass") : p + " of them " + (p === 1 ? "passes" : "pass");
    return (
      ". " +
      n +
      (n === 1 ? " leg passes" : " legs pass") +
      " water narrower than your corridor, checked at the harbour corridor" +
      (p > 0 ? "; " + which + " under a bridge on the fairway's line: keep to the line" : "")
    );
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

  /**
   * A host may hand back a written point through its map projection, a few 1e-14 degrees off:
   * positions closer than this (about a millimetre) are the same point.
   */
  const SAME_DEGREES = 1e-8;

  function samePosition(x, y) {
    return Math.abs(x[0] - y[0]) < SAME_DEGREES && Math.abs(x[1] - y[1]) < SAME_DEGREES;
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
        return !!x && !!y && samePosition(x, y);
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
          narrowsText(legs) +
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
      if (!samePosition(x, y)) {
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
    FAIRWAY_GAP: "under a bridge, on the fairway line",
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


  /** Metres a second in a knot. */
  const KNOT = 1852 / 3600;

  /** The most a request's accepted probability may be (`src/api/plan-request.ts`). */
  const MAX_PROBABILITY = 0.5;

  /**
   * The panel's three levels of the risk accepted on a leg, P(UKC < 0), around the route check's
   * own setting `p`: a tenth of it, it, and five times it. A leg at or above the level is
   * marginal, and fails from five times the level (at most 50 %), as the route check rates it.
   */
  function riskLevels(p) {
    return {
      low: p / 10,
      normal: p,
      high: Math.min(5 * p, MAX_PROBABILITY)
    };
  }

  /** A probability as a short percentage, kept on one line: "1 %", "0.1 %", "5 %". */
  function percent(p) {
    return String(Number((p * 100).toPrecision(2))) + "\u00a0%";
  }

  /**
   * A number as typed, with a decimal comma or point ("7,5" or "7.5"); NaN for anything else, so
   * a value that is not a number is refused, never read as another.
   */
  function decimal(v) {
    const t = String(v).trim().replace(",", ".");
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN;
  }

  /**
   * The plan's route parameters from the panel's choice over the route check's `defaults`
   * (`GET /status`): `xte` in metres and `knots` as typed, each null for the default, and the
   * `risk` level. `fields` are the request fields of every value typed and of a risk level other
   * than normal; `changed` whether any of them differs from the defaults; `errors` the values out
   * of the planner's range, and a low or high risk level without the route check's probability
   * to set it from, when the plan cannot be asked for.
   */
  function routeParams(defaults, choice) {
    const d = defaults || {};
    const c = choice || {};
    const errors = [];
    const fields = {};
    const blank = function (v) {
      return v === null || v === undefined || String(v).trim() === "";
    };
    // A blank field is the route check's own setting, sent as nothing; a typed value is sent as
    // typed, so it holds if the route check's setting changes while the panel is open.
    const xte = blank(c.xte) ? d.xteLimit : decimal(c.xte);
    if (!blank(c.xte) && !(isFinite(xte) && xte >= 0 && xte <= 1000)) {
      errors.push("the cross-track limit must be 0 to 1000 m");
    } else if (!blank(c.xte)) {
      fields.xteLimit = xte;
    }
    const speed = blank(c.knots) ? d.speed : decimal(c.knots) * KNOT;
    if (!blank(c.knots) && !(isFinite(speed) && speed >= 0.1 && speed <= 30)) {
      errors.push("the speed must be 0.2 to 58 kn");
    } else if (!blank(c.knots)) {
      fields.speed = speed;
    }
    const draft = blank(c.draft) ? d.draft : decimal(c.draft);
    if (!blank(c.draft) && !(isFinite(draft) && draft >= 0.01 && draft <= 30)) {
      errors.push("the draft must be 0.01 to 30 m");
    } else if (!blank(c.draft)) {
      fields.draft = draft;
    }
    const level = c.risk === "low" || c.risk === "high" ? c.risk : "normal";
    const probability = isFinite(d.probability) ? riskLevels(d.probability)[level] : undefined;
    // Without it the server would plan at its own probability, the chosen level left unsaid.
    if (level !== "normal" && probability === undefined) {
      errors.push("the route check's settings have not loaded, so the chosen risk level cannot be applied");
    } else if (level !== "normal") {
      fields.probability = probability;
    }
    return {
      draft: draft,
      xte: xte,
      speed: speed,
      level: level,
      probability: probability,
      fields: fields,
      changed:
        fields.probability !== undefined ||
        (fields.xteLimit !== undefined && fields.xteLimit !== d.xteLimit) ||
        (fields.speed !== undefined && fields.speed !== d.speed) ||
        (fields.draft !== undefined && fields.draft !== d.draft),
      errors: errors
    };
  }

  /**
   * The closed parameter row: "Draft 0.9 m · XTE 30 m · 4.9 kn · normal risk, under 1 %", with
   * "changed" when the plan's differ from the route check's.
   */
  function paramsText(params) {
    const p = params || {};
    const parts = [];
    if (isFinite(p.draft)) {
      parts.push("Draft " + Number(p.draft.toFixed(2)) + " m");
    }
    if (isFinite(p.xte)) {
      parts.push("XTE " + Number(p.xte.toFixed(1)) + " m");
    }
    if (isFinite(p.speed)) {
      parts.push((p.speed / KNOT).toFixed(1) + " kn");
    }
    parts.push(
      (p.level || "normal") + " risk" + (isFinite(p.probability) ? ", under " + percent(p.probability) : "")
    );
    return parts.join(" · ") + (p.changed ? " (changed)" : "");
  }

  /**
   * Whether a refused plan is offered again as the lowest risk-weighted route, its risky legs
   * marked: a refusal of a request that did not ask for it already.
   */
  function offersFallback(status, request) {
    return status === 422 && !(request && request.fallback === true);
  }

  const api = {
    API: API,
    movedPoint: movedPoint,
    spliceLegs: spliceLegs,
    legNote: legNote,
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
    legLabel: legLabel,
    KNOT: KNOT,
    riskLevels: riskLevels,
    percent: percent,
    routeParams: routeParams,
    decimal: decimal,
    paramsText: paramsText,
    offersFallback: offersFallback
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PLANNER = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
