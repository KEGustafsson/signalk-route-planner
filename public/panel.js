// Route planner panel: plans between the ends of a visible route and writes
// the plan back into it as an unsaved change (plan §4.5).
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

const P = globalThis.PLANNER;
const THEME = globalThis.PLANNER_THEME;
const client = await connectExtension();
// Not awaited: a host that offers night mode but never answers must not stall the panel.
void THEME.followHost(client, document);

const select = document.getElementById("route");
const button = document.getElementById("plan");
const result = document.getElementById("result");
const table = document.getElementById("legs");

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
        [(l.risk * 100).toFixed(2) + " %", ""]
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

async function planSelected() {
  const routeId = select.value;
  if (!routeId) {
    return;
  }
  button.disabled = true;
  table.hidden = true;
  show("muted", "Planning…");
  try {
    const route = await client.call("route.get", { routeId });
    const ends = P.endsOf(route.points);
    if (!ends) {
      show("fail", "The route needs a start and a destination point.");
      return;
    }
    const res = await fetch(`${P.API}/plan`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...ends,
        ...(document.getElementById("accept").checked && { accept: ["NOT_FOR_NAVIGATION"] }),
        ...(document.getElementById("fallback").checked && { fallback: true })
      })
    });
    const body = await res.json().catch(() => ({}));
    const s = P.summary(res.status, body);
    show(s.kind, s.text);
    if (res.status === 200) {
      await client.call("route.replace", {
        routeId,
        points: P.planPoints(body.route.coordinates, route.points)
      });
      showLegs(body.check.legs);
    }
  } catch (err) {
    show("unverified", "Not planned: the chart host or the planner did not answer.");
    console.warn("route planner", err);
  } finally {
    button.disabled = false;
  }
}

button.addEventListener("click", () => void planSelected());
await client.subscribe(["route.visible", "route.hidden"], () => void listRoutes());
await listRoutes();
