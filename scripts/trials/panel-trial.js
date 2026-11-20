#!/usr/bin/env node
"use strict";

// Panel trial (docs/trials.md): the planner panel in Chromium, hosted by a chart host built on
// the Plotter Extensions bus host (panel-host.html), planning on real chart data through
// signalk-underkeel's planning API, as the field trials do. It plans a route with alternatives,
// writes one, drags a waypoint and waits for the legs beside it to be planned again.
//
//   node scripts/trials/panel-trial.js [case]
//
// Needs what trial.js needs, this package built, and Playwright with Chromium. Writes
// screenshots to data/trials/panel-*.png. Exits 1 when a step does not do what it should.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { apiFor, indexFor } = require("./trial");

const ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.resolve(process.env.TRIALS_DIR ?? path.join(ROOT, "data", "trials"));
const BUS = path.dirname(require.resolve("signalk-plotterext-bus/host"));
const PUBLIC = path.join(ROOT, "public");
const { plan } = require(path.join(ROOT, "lib", "plan", "plan.js"));
const { DEFAULT_PLAN } = require(path.join(ROOT, "lib", "plan", "options.js"));
const { parsePlanRequest } = require(path.join(ROOT, "lib", "api", "plan-request.js"));

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css"
};

function file(res, f) {
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] ?? "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}

/** Inside `root`, or undefined. */
function under(root, rel) {
  const f = path.resolve(root, `.${rel}`);
  return f.startsWith(root + path.sep) ? f : undefined;
}

function server(c, index) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://trial");
    if (req.method === "POST" && url.pathname === "/plugins/signalk-route-planner/v1/plan") {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
      }
      const now = Date.now();
      const parsed = parsePlanRequest(JSON.parse(text || "{}"), now);
      if (!parsed.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: parsed.errors }));
        return;
      }
      const r = parsed.value;
      const departure = r.departure ?? now;
      const reply = await plan(
        apiFor(index, c.draft, c.tide, departure),
        // The plugin's configured cross-track limit for the trip, as the field trial plans it.
        { ...r, departure, speed: r.speed ?? 3, xteLimit: r.xteLimit ?? c.xteLimit },
        new AbortController().signal,
        now,
        { ...DEFAULT_PLAN, maxWork: c.maxWork ?? 100_000_000 }
      );
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
      return;
    }
    const at =
      url.pathname === "/host.html"
        ? path.join(__dirname, "panel-host.html")
        : url.pathname.startsWith("/bus/")
          ? under(BUS, url.pathname.slice(4))
          : url.pathname.startsWith("/plotterext/signalk-route-planner/")
            ? under(PUBLIC, url.pathname.slice("/plotterext/signalk-route-planner".length))
            : undefined;
    if (!at) {
      res.writeHead(404).end();
      return;
    }
    file(res, at);
  });
}

async function main() {
  const name = process.argv[2] ?? "miami-fisher-island-alternatives";
  const { areas, cases } = JSON.parse(fs.readFileSync(path.join(__dirname, "trials.json"), "utf8"));
  const c = cases.find((k) => k.name === name);
  if (!c) {
    throw new Error(`no trial case ${name}`);
  }
  const index = await indexFor(areas, c);
  const srv = server(c, index);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const failures = [];
  const check = (ok, what) => {
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${what}\n`);
    if (!ok) {
      failures.push(what);
    }
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.on(
      "console",
      (m) => m.type() === "warning" && process.stdout.write(`  console: ${m.text()}\n`)
    );
    const points = [
      { position: c.from, name: "Start" },
      { position: c.to, name: "Destination" }
    ];
    await page.goto(`${base}/host.html?points=${encodeURIComponent(JSON.stringify(points))}`);
    const panel = page.frameLocator("#panel");
    await panel.locator("#route option").first().waitFor({ state: "attached", timeout: 30_000 });
    await panel.locator("#fallback").check();
    await panel.locator("#alternatives").check();
    await panel.locator("#plan").click();
    const result = panel.locator("#result");
    await result
      .filter({ hasText: /^(Planned|No route|Not planned)/ })
      .waitFor({ timeout: 300_000 });
    const text = await result.textContent();
    check(/^Planned/.test(text), `planned with alternatives: ${text}`);
    const trial = () =>
      page.evaluate(() => ({
        routes: globalThis.trial.routes(),
        overlays: globalThis.trial.overlays()
      }));
    let state = await trial();
    const written = state.routes[0].points;
    check(written.length > 2, `the plan was written into the route: ${written.length} points`);
    const drawn = state.overlays.alternatives?.data.features ?? [];
    check(
      drawn.length >= 1,
      `the alternatives were drawn: ${drawn.map((f) => f.properties.name).join(", ")}`
    );
    check(
      (await panel.locator("#choices div").count()) === 3,
      "the panel lists the three alternatives"
    );
    check(
      (await panel.locator("#legs tbody tr").count()) === written.length - 1,
      "the panel lists every leg"
    );
    await page.screenshot({ path: path.join(DATA, "panel-planned.png") });

    const use = panel.locator("#choices button").first();
    if ((await use.count()) > 0) {
      await use.click();
      await result.filter({ hasText: /^Wrote the / }).waitFor({ timeout: 30_000 });
      state = await trial();
      check(
        JSON.stringify(state.routes[0].points) !== JSON.stringify(written),
        `another alternative was written: ${await result.textContent()}`
      );
    }

    // Drag the first waypoint the plan added a few metres north, as a user would on the chart.
    state = await trial();
    const before = state.routes[0].points;
    const k = 1;
    const moved = [before[k].position[0], before[k].position[1] + 0.0002];
    await page.evaluate(([i, p]) => globalThis.trial.drag("trip", i, p), [k, moved]);
    await result.filter({ hasText: /beside the moved waypoint/ }).waitFor({ timeout: 300_000 });
    const after = (await trial()).routes[0].points;
    const replanned = await result.textContent();
    check(
      after.some((p) => p.position[0] === moved[0] && p.position[1] === moved[1]),
      `the moved waypoint stays where it was dragged: ${replanned}`
    );
    check(
      /^Planned the legs beside/.test(replanned),
      `the legs beside it were planned again: ${before.length} → ${after.length} points`
    );
    await page.screenshot({ path: path.join(DATA, "panel-replanned.png") });
  } finally {
    await browser.close();
    srv.close();
  }
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`panel trial: ${err.stack ?? err}\n`);
  process.exit(2);
});
