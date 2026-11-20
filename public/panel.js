// Route planner panel: plans between the ends of a visible route, or from the boat, and writes
// the plan back into it as an unsaved change; offers alternatives drawn on the map, and plans
// again the legs beside a waypoint dragged on the planned route (plan §4.5).
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
const has = (c) => client.hasCapability(c);

/** The boat's last position from Signal K, when the host streams it. */
let boat;
/** The points the panel last wrote into a route: a drag of one of them is planned again. */
let written;

function show(kind, text) {
  result.className = kind;
  result.textContent = text;
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

/** The options the panel's controls set, for a plan between `ends`, with alternatives if asked. */
function requestFor(ends, alternatives = $("alternatives").checked) {
  return {
    ...ends,
    ...($("accept").checked && { accept: ["NOT_FOR_NAVIGATION"] }),
    ...($("fallback").checked && { fallback: true }),
    ...($("lines").checked && { preferLines: true }),
    // Alternatives are planned at one departure: the panel's wait for the tide is left out.
    ...(alternatives
      ? { alternatives: true }
      : latest(Number($("wait").value), $("waitEnRoute").checked))
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

/** Writes `coordinates` into the route, unless it changed since `route` was read. */
async function write(routeId, route, coordinates) {
  // Planning can wait minutes for the chart index: a route edited meanwhile is not overwritten.
  const now = await client.call("route.get", { routeId });
  if (!P.samePoints(route.points, now && now.points)) {
    show("unverified", "Not written: the route changed while it was planned. Plan it again.");
    return false;
  }
  const points = P.planPoints(coordinates, route.points);
  // Set first: the host's event for this write must not read as a drag of the old points.
  written = { routeId, points };
  await client.call("route.replace", { routeId, points });
  return true;
}

/** The offered alternatives, each with a button that writes it into the route instead. */
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
        if (await write(routeId, written ? { points: written.points } : route, a.route.coordinates)) {
          body.chosen = a.name;
          showLegs(a.legs || []);
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

async function planSelected() {
  const routeId = select.value;
  if (!routeId) {
    return;
  }
  button.disabled = true;
  table.hidden = true;
  choices.replaceChildren();
  show("muted", "Planning…");
  try {
    const route = await client.call("route.get", { routeId });
    const ends = $("boat").checked ? P.fromBoat(P.endsOf(route.points), boat) : P.endsOf(route.points);
    if (!ends) {
      show("fail", "The route needs a start and a destination point.");
      return;
    }
    const { status, body } = await planRequest(requestFor(ends));
    if (P.preparingWait(status, body, null) !== null) {
      show("unverified", "Not planned: the chart index for this trip's region is still being built; plan again later.");
      return;
    }
    const s = P.summary(status, body);
    show(s.kind, s.text);
    await drawAlternatives(body.alternatives, body.chosen);
    if (status === 200 && (await write(routeId, route, body.route.coordinates))) {
      showLegs(body.check.legs);
      if (body.alternatives) {
        showChoices(routeId, { points: written.points }, body);
      }
    }
  } catch (err) {
    show("unverified", "Not planned: the chart host or the planner did not answer.");
    console.warn("route planner", err);
  } finally {
    button.disabled = false;
  }
}

/**
 * A waypoint dragged on the route the panel wrote: the legs on either side of it planned again
 * and spliced in. A drag that cannot be planned stays as the user left it, with the reason.
 */
async function replanDrag(routeId) {
  if (!$("replan").checked || !written || written.routeId !== routeId) {
    return;
  }
  const now = await client.call("route.get", { routeId });
  const i = P.movedPoint(written.points, now && now.points);
  if (i < 0) {
    return;
  }
  const pts = now.points;
  const leg = async (a, b) => {
    const ends = { from: pts[a].position, to: pts[b].position };
    const { status, body } = await planRequest(requestFor(ends, false));
    return status === 200 ? body.route.coordinates : P.summary(status, body).text;
  };
  show("muted", "Planning the legs beside the moved waypoint…");
  const left = i > 0 ? await leg(i - 1, i) : [];
  const right = i < pts.length - 1 ? await leg(i, i + 1) : [];
  const failed = [left, right].find((l) => typeof l === "string");
  if (failed) {
    written = { routeId, points: pts };
    show("unverified", "The moved waypoint stays as you left it, the legs beside it unchecked: " + failed);
    return;
  }
  const points = P.spliceLegs(pts, i, left, right);
  const again = await client.call("route.get", { routeId });
  if (!P.samePoints(pts, again && again.points)) {
    return;
  }
  written = { routeId, points };
  await client.call("route.replace", { routeId, points });
  show("ok", "Planned the legs beside the moved waypoint again. Plan the whole route to check it all.");
}

button.addEventListener("click", () => void planSelected());
$("alternatives").addEventListener("change", (e) => {
  $("wait").disabled = e.target.checked;
  $("waitEnRoute").disabled = e.target.checked;
});
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
