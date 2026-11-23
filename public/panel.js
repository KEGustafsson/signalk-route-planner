// Route planner panel: plans between the ends of a visible route, or from the boat, and writes
// the plan back into it as an unsaved change; offers alternatives drawn on the map, the
// lowest-risk route after a refusal, and plans again the legs beside a waypoint dragged on the
// planned route (plan §4.5).
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

const P = globalThis.PLANNER;
const THEME = globalThis.PLANNER_THEME;
const client = await connectExtension();
// Not awaited: a host that offers night mode but never answers must not stall the panel.
void THEME.followHost(client, document);

const $ = (id) => document.getElementById(id);
const select = $("route");
const button = $("plan");
const result = $("result");
const table = $("legs");
const choices = $("choices");
const creditsLine = $("credits");
const lowest = $("lowest");
const has = (c) => client.hasCapability(c);

/** The boat's last position from Signal K, when the host streams it. */
let boat;
/** The points the panel last wrote into a route: a drag of one of them is planned again. */
let written;
/**
 * The planning in progress: a plan, a choice of alternative or a drag's re-plan. Each takes the
 * next number and, once its replies are in, changes the route and the panel only while it is
 * still the latest, so a slow one never undoes what a later one did.
 */
let latestOp = 0;
/** The writes to the route: what the panel shows is the last written route's. */
const routeWrites = P.writes();

function show(kind, text) {
  result.className = kind;
  result.textContent = text;
}

/** The credits for the data the route on the chart leaned on; none hides the line. */
let shownCredits = [];
function showCredits(list) {
  shownCredits = list;
  creditsLine.textContent = list.map((a) => a.text).join(" · ");
  creditsLine.hidden = list.length === 0;
}

async function listRoutes() {
  const keep = select.value;
  const { routes } = await client.call("route.list");
  select.replaceChildren(
    ...routes.map((r) => {
      const o = document.createElement("option");
      o.value = r.routeId;
      o.textContent = r.name || r.routeId;
      return o;
    })
  );
  if (routes.some((r) => r.routeId === keep)) {
    select.value = keep;
  }
  button.disabled = routes.length === 0;
  if (routes.length === 0) {
    show("muted", "Draw a route from where you are to where you want to go, then plan it here.");
  }
}

function showLegs(legs) {
  const body = table.querySelector("tbody");
  body.replaceChildren(
    ...legs.map((l, i) => {
      const tr = document.createElement("tr");
      for (const [text, cls] of [
        [String(i + 1), ""],
        [P.nm(l.length), ""],
        [P.legLabel(l), l.status],
        [(l.risk * 100).toFixed(2) + " %", ""],
        [P.legNote(l), "muted"]
      ]) {
        const td = document.createElement("td");
        td.textContent = text;
        if (cls) {
          td.className = cls;
        }
        tr.append(td);
      }
      return tr;
    })
  );
  table.hidden = legs.length === 0;
}

/** The alternatives drawn on the map; none clears them. A host without data overlays shows none. */
async function drawAlternatives(alternatives, chosen) {
  if (!has("overlays.data")) {
    return;
  }
  try {
    const data = P.alternativesGeoJSON(alternatives, chosen);
    await client.call("overlay.setData", { overlayId: "alternatives", source: "routes", data });
  } catch (err) {
    console.warn("route planner alternatives overlay", err);
  }
}

/**
 * The departure and the latest departure, `hours` after it, as request fields, both from one
 * reading of the clock so the wait never exceeds the server's limit, and `waitEnRoute` when
 * the boat may wait on the way too; none for 0.
 */
function latest(hours, enRoute) {
  if (!(hours > 0)) {
    return {};
  }
  const now = Date.now();
  return {
    departure: new Date(now).toISOString(),
    latestDeparture: new Date(now + hours * 3_600_000).toISOString(),
    ...(enRoute && { waitEnRoute: true })
  };
}

/**
 * The options the panel's controls set, for a plan between `ends`: the route asked for, the
 * route parameters that differ from the route check's, and the wait for the tide (with waiting
 * on the way) unless the three alternatives are asked for; `fallback` for the lowest-risk route.
 */
function requestFor(ends, alternatives = $("alternatives").checked, fallback = false) {
  return {
    ...ends,
    ...(fallback && { fallback: true }),
    ...($("lines").checked && { preferLines: true }),
    ...paramsNow().fields,
    // Alternatives are planned at one departure: the panel's wait for the tide is left out.
    ...(alternatives ? { alternatives: true } : latest(Number($("wait").value), true))
  };
}

/** POST /plan, asked again while signalk-underkeel builds the trip's chart index. */
async function planRequest(request) {
  let res;
  let body;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${P.API}/plan`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    body = await res.json().catch(() => ({}));
    const wait = P.preparingWait(res.status, body, res.headers.get("Retry-After"));
    if (wait === null || attempt >= P.MAX_PREPARING) {
      return { status: res.status, body };
    }
    const s = P.summary(res.status, body);
    show(s.kind, s.text);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
}

/**
 * Writes `coordinates` into the route, unless it changed since `route` was read or a later
 * planning (`op`) took over.
 */
async function write(routeId, route, coordinates, op) {
  // Planning can wait minutes for the chart index: a route edited meanwhile is not overwritten.
  const now = await client.call("route.get", { routeId });
  if (op !== latestOp) {
    return false;
  }
  if (!P.samePoints(route.points, now && now.points)) {
    show("unverified", "Not written: the route changed while it was planned. Plan it again.");
    return false;
  }
  const points = P.planPoints(coordinates, route.points);
  // Set first: the host's event for this write must not read as a drag of the old points.
  written = { routeId, points };
  const ticket = routeWrites.take();
  await client.call("route.replace", { routeId, points });
  // Shown unless a later write completed meanwhile; a later write that fails, or a plan that
  // writes nothing, leaves this route, and what is shown for it, on the chart.
  return routeWrites.done(ticket);
}

/** The alternatives and their overlay withdrawn: the route they were planned for has changed. */
function dropChoices() {
  choices.replaceChildren();
  void drawAlternatives([], undefined);
}

/**
 * The offered alternatives, each with a button that writes it into the route instead. `route`
 * is the route as this set of alternatives last wrote it: one changed since is not overwritten.
 */
function showChoices(routeId, route, body) {
  const offered = (body.alternatives || []).map((a) => {
    const row = document.createElement("div");
    const text = document.createElement("span");
    text.textContent = P.alternativeText(a) + (a.name === body.chosen ? " (written)" : "");
    row.append(text);
    if (a.route && !a.sameAs && a.name !== body.chosen) {
      const use = document.createElement("button");
      use.type = "button";
      use.textContent = "Use";
      use.addEventListener("click", async () => {
        const op = ++latestOp;
        if (await write(routeId, route, a.route.coordinates, op)) {
          body.chosen = a.name;
          showLegs(a.legs || []);
          showCredits(P.credits(a.attributions));
          showChoices(routeId, { points: written.points }, body);
          void drawAlternatives(body.alternatives, a.name);
          show(a.status, "Wrote the " + a.name + " route: " + P.alternativeText(a));
        }
      });
      row.append(use);
    }
    return row;
  });
  choices.replaceChildren(...offered);
}

async function planSelected(fallback = false) {
  const routeId = select.value;
  if (!routeId) {
    return;
  }
  const params = paramsNow();
  if (params.errors.length > 0) {
    show("fail", "Not planned: " + params.errors.join("; ") + ".");
    return;
  }
  const op = ++latestOp;
  button.disabled = true;
  lowest.hidden = true;
  table.hidden = true;
  dropChoices();
  // The credits stay with the route on the chart until a plan replaces it.
  show("muted", "Planning…");
  try {
    if ($("boat").checked && !P.hasPosition(boat)) {
      show(
        "fail",
        "Not planned: no boat position has come from Signal K. Pick Start: Route's first point to plan from it."
      );
      return;
    }
    const route = await client.call("route.get", { routeId });
    const ends = $("boat").checked ? P.fromBoat(P.endsOf(route.points), boat) : P.endsOf(route.points);
    if (!ends) {
      show("fail", "The route needs a start and a destination point.");
      return;
    }
    const request = requestFor(ends, $("alternatives").checked, fallback);
    const { status, body } = await planRequest(request);
    if (op !== latestOp) {
      return;
    }
    lowest.hidden = !P.offersFallback(status, request);
    if (P.preparingWait(status, body, null) !== null) {
      show("unverified", "Not planned: the chart index for this trip's region is still being built; plan again later.");
      return;
    }
    const s = P.summary(status, body);
    show(s.kind, s.text);
    await drawAlternatives(body.alternatives, body.chosen);
    if (status === 200 && (await write(routeId, route, body.route.coordinates, op))) {
      showLegs(body.check.legs);
      showCredits(P.credits(body.attributions));
      if (body.alternatives) {
        showChoices(routeId, { points: written.points }, body);
      }
    }
  } catch (err) {
    if (op === latestOp) {
      show("unverified", "Not planned: the chart host or the planner did not answer.");
    }
    console.warn("route planner", err);
  } finally {
    button.disabled = false;
  }
}

/**
 * A waypoint dragged on the route the panel wrote: the legs on either side of it planned again
 * and spliced in, with their own checks. A drag that cannot be planned stays as the user left
 * it, with the reason. Only those legs are checked, so the panel never calls the whole route
 * passed: it asks for a plan of the whole route.
 */
async function replanDrag(routeId) {
  if (!written || written.routeId !== routeId) {
    return;
  }
  const now = await client.call("route.get", { routeId });
  const i = P.movedPoint(written.points, now && now.points);
  if (i < 0) {
    return;
  }
  const op = ++latestOp;
  const pts = now.points;
  // What was shown was for the route before the drag.
  table.hidden = true;
  lowest.hidden = true;
  dropChoices();
  // Each leg is checked at the time the boat sails it, without waiting for the tide: a drag
  // that would need a wait is refused, never written with the wait left unsaid. The leg after
  // the waypoint is checked from when the boat reaches it.
  const leg = async (a, b, departure) => {
    const ends = { from: pts[a].position, to: pts[b].position };
    const request = {
      ...requestFor(ends, false),
      departure,
      latestDeparture: undefined,
      waitEnRoute: undefined
    };
    const { status, body } = await planRequest(request);
    if (status !== 200) {
      return P.summary(status, body).text;
    }
    return {
      coordinates: body.route.coordinates,
      status: body.status,
      legs: body.check.legs,
      arrival: body.arrival,
      attributions: body.attributions
    };
  };
  const none = { coordinates: [], status: "ok", legs: [], attributions: [] };
  show("muted", "Planning the legs beside the moved waypoint…");
  const left = i > 0 ? await leg(i - 1, i) : none;
  const right =
    i === pts.length - 1 || typeof left === "string"
      ? none
      : left.arrival === undefined && i > 0
        ? "the planner did not say when the boat reaches the moved waypoint."
        : await leg(i, i + 1, left.arrival);
  if (op !== latestOp) {
    return;
  }
  const failed = [left, right].find((l) => typeof l === "string");
  if (failed) {
    written = { routeId, points: pts };
    show("unverified", "The moved waypoint stays as you left it, the legs beside it unchecked: " + failed);
    return;
  }
  const points = P.spliceLegs(pts, i, left.coordinates, right.coordinates);
  const again = await client.call("route.get", { routeId });
  if (op !== latestOp || !P.samePoints(pts, again && again.points)) {
    return;
  }
  written = { routeId, points };
  const ticket = routeWrites.take();
  await client.call("route.replace", { routeId, points });
  if (!routeWrites.done(ticket)) {
    return;
  }
  const status = P.worstStatus([left.status, right.status]);
  showLegs([...left.legs, ...right.legs]);
  // The rest of the route still leans on what it did: the new legs' credits add to its own.
  showCredits(P.credits(shownCredits, left.attributions, right.attributions));
  show(
    status === "ok" ? "muted" : status,
    "Planned the legs beside the moved waypoint again: they are " +
      status +
      (status === "ok" ? "" : " (see the legs below)") +
      ". The rest of the route is not checked again: plan the whole route to check it all."
  );
}

/** The route check's settings (`GET /status`): the parameters a plan takes unless changed here. */
let defaults;
const RISK = { low: "riskLow", normal: "riskNormal", high: "riskHigh" };

/** The route parameters as the panel's fields set them now (`routeParams`). */
function paramsNow() {
  const risk = Object.keys(RISK).find((k) => $(RISK[k]).checked) ?? "normal";
  return P.routeParams(defaults, {
    draft: $("draft").value,
    xte: $("xte").value,
    knots: $("knots").value,
    risk
  });
}

/** The closed row's line, the fields' hints and the risk levels' meaning, from the fields now. */
function showParams() {
  const p = paramsNow();
  $("paramsText").textContent = p.errors.length > 0 ? p.errors.join("; ") : P.paramsText(p);
  $("paramsText").className = p.errors.length > 0 ? "fail" : "";
  if (defaults) {
    $("draft").placeholder = defaults.draft === undefined ? "" : String(defaults.draft);
    $("xte").placeholder = String(defaults.xteLimit);
    $("knots").placeholder = (defaults.speed / P.KNOT).toFixed(1);
    const l = P.riskLevels(defaults.probability);
    $("riskNote").textContent =
      "A leg passes under the level, is marginal from it and fails from five times it. Low: " +
      P.percent(l.low) +
      ", normal (the route check's): " +
      P.percent(l.normal) +
      ", high: " +
      P.percent(l.high) +
      "; blank fields take signalk-underkeel's settings, the draft Signal K's design.draft unless set there. A draft typed here holds until the panel is closed.";
  }
}

/** Waiting for the tide applies to one route at a departure: the three alternatives leave now. */
function showTide() {
  const three = $("alternatives").checked;
  $("wait").disabled = three;
  $("threeNote").hidden = !three;
  $("waitNote").hidden = three || Number($("wait").value) === 0;
}

/**
 * The controls whose choice the panel keeps in this browser, so it opens as the last plan was
 * asked for. A browser that keeps nothing opens on the defaults.
 */
const KEPT = ["boat", "first", "shortest", "lines", "alternatives", "wait", "xte", "knots", ...Object.values(RISK)];
const STORE = "signalk-route-planner.panel.v2";

function restoreChoices() {
  let kept;
  try {
    kept = JSON.parse(localStorage.getItem(STORE) || "{}") || {};
  } catch {
    return;
  }
  for (const id of KEPT) {
    const el = $(id);
    const v = kept[id];
    if (el.type === "radio" || el.type === "checkbox") {
      if (typeof v === "boolean") {
        el.checked = v;
      }
    } else if (typeof v === "string" && (el.tagName !== "SELECT" || [...el.options].some((o) => o.value === v))) {
      el.value = v;
    }
  }
}

function keepChoices() {
  const kept = {};
  for (const id of KEPT) {
    const el = $(id);
    kept[id] = el.type === "radio" || el.type === "checkbox" ? el.checked : el.value;
  }
  try {
    localStorage.setItem(STORE, JSON.stringify(kept));
  } catch {
    // Nothing kept: the panel opens on its defaults next time.
  }
}

async function loadDefaults() {
  try {
    const res = await fetch(`${P.API}/status`, { credentials: "same-origin" });
    const body = await res.json();
    defaults = body && body.defaults;
  } catch (err) {
    console.warn("route planner status", err);
  }
  showParams();
}

button.addEventListener("click", () => void planSelected());
lowest.addEventListener("click", () => void planSelected(true));
$("paramsToggle").addEventListener("click", () => {
  const open = $("paramsBody").hidden;
  $("paramsBody").hidden = !open;
  $("paramsToggle").textContent = open ? "Done" : "Change";
  $("paramsToggle").setAttribute("aria-expanded", String(open));
});
$("paramsReset").addEventListener("click", () => {
  $("draft").value = "";
  $("xte").value = "";
  $("knots").value = "";
  $("riskNormal").checked = true;
  showParams();
  keepChoices();
});
restoreChoices();
showTide();
showParams();
// The draft is not kept: a draft typed for one trip must not plan the next one unseen.
for (const id of [...KEPT, "draft"]) {
  $(id).addEventListener("input", () => {
    showTide();
    showParams();
    keepChoices();
  });
  $(id).addEventListener("change", () => {
    showTide();
    showParams();
    keepChoices();
  });
}
void loadDefaults();
await client.subscribe(["route.visible", "route.hidden"], () => void listRoutes());
if (has("routes")) {
  await client.subscribe(["route.**"], (name, params) => {
    if (name !== "route.hidden" && params && params.routeId) {
      void replanDrag(params.routeId).catch((err) => console.warn("route planner re-plan", err));
    }
  });
}
if (has("signalk.stream")) {
  await client.signalk.subscribe(["navigation.position"], (ev) => {
    boat = ev.value;
  });
}
await listRoutes();
