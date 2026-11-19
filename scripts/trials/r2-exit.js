#!/usr/bin/env node
"use strict";

// R2's exit trial (docs/DEVELOPMENT-PLAN.md §8, docs/trials.md): a 50 nm plan past the chart
// box, Turku guest harbour to Utö, on signalk-underkeel's own planning boxes, depth survey and
// build processes, with a 10 km chart box around the start, as on a 2 GB Raspberry Pi 4.
//
//   node scripts/trials/r2-exit.js
//
// Run it in a 2 GB memory limit to measure a Pi's budget: the build processes size their heaps
// from it, and TRIAL_CGROUP names the cgroup whose peak is reported (cgroup v1
// memory.max_usage_in_bytes, or v2 memory.peak). Needs network (Traficom WFS), this package
// built and a built signalk-underkeel 0.8.0 or later checkout next to this one or at
// UNDERKEEL_DIR. Writes data/trials/r2-exit.json and .geojson. Exits 1 when the plan is not 200.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const UK = path.join(
  path.resolve(process.env.UNDERKEEL_DIR ?? path.join(ROOT, "..", "signalk-underkeel")),
  "lib"
);
const DATA = path.resolve(process.env.TRIALS_DIR ?? path.join(ROOT, "data", "trials"));
const WORK = path.join(DATA, "r2-exit");

const need = (p) => {
  if (!fs.existsSync(p)) {
    throw new Error(`${p} is missing: build it first (npm run build there)`);
  }
  return require(p);
};
const uk = (m) => need(path.join(UK, `${m}.js`));
const { plan } = need(path.join(ROOT, "lib", "plan", "plan.js"));
const { DEFAULT_PLAN } = need(path.join(ROOT, "lib", "plan", "options.js"));
const { Preparer } = need(path.join(ROOT, "lib", "plan", "prepare.js"));

const FROM = [22.2447535, 60.4399228];
// Utö guest harbour.
const TO = [21.3702, 59.7823];
const DRAFT = 1.8;

/** The cgroup's peak memory, MB, or undefined. */
function cgroupPeakMb() {
  const dir = process.env.TRIAL_CGROUP;
  for (const f of ["memory.peak", "memory.max_usage_in_bytes"]) {
    const p = dir && path.join(dir, f);
    if (p && fs.existsSync(p)) {
      return Math.round(Number(fs.readFileSync(p, "utf8")) / 2 ** 20);
    }
  }
  return undefined;
}

/**
 * The chart box around the start: the Traficom WFS over 10 km each way, indexed here. Cut from
 * the Turku trial's cell when `npm run trial` has downloaded it, else downloaded.
 */
async function chartBox(config) {
  const { boxAround, downloadWfsCell, toCellLayers, writeCell, DEFAULT_WFS_URL } = uk("ingest/wfs");
  const bbox = boxAround(FROM, 10);
  const dir = path.join(WORK, "chart-box", "FI1WFS01");
  const turku = path.join(DATA, "turku", "catzoc-3", "FI1WFS01");
  if (!fs.existsSync(path.join(dir, "DEPARE.geojson")) && fs.existsSync(turku)) {
    const read = (layer) =>
      JSON.parse(fs.readFileSync(path.join(turku, `${layer}.geojson`), "utf8")).features.map(
        (f) => ({ ...f, properties: { ...f.properties, IDENTIFIER: f.properties.LNAM } })
      );
    const [w, s, e, n] = bbox;
    const soundings = read("SOUNDG").filter(
      ({
        geometry: {
          coordinates: [x, y]
        }
      }) => x >= w && x < e && y >= s && y < n
    );
    const l = { depthAreas: read("DEPARE"), dredgedAreas: read("DRGARE"), soundings };
    writeCell(dir, toCellLayers(l, bbox, new Date(), 3));
  }
  // The WFS stalls at times: a download is tried three times.
  for (let tries = 1; !fs.existsSync(path.join(dir, "DEPARE.geojson")); tries++) {
    try {
      await downloadWfsCell({ fetch, url: DEFAULT_WFS_URL, bbox, dir, now: new Date(), catzoc: 3 });
    } catch (err) {
      if (tries === 3) {
        throw err;
      }
      process.stdout.write(`     chart box download: ${err.message}; again\n`);
    }
  }
  const { readCell } = uk("ingest/cell-source");
  const index = uk("spatial/chart-index").buildChartIndex([await readCell(dir, 0)], {
    leafZoom: config.leafZoom
  });
  return { bbox, index };
}

const timed =
  (log, name, fn) =>
  async (...args) => {
    const t = Date.now();
    const r = await fn(...args);
    log.push({
      step: name,
      ok: r.ok,
      ...(r.ok ? {} : { status: r.status, error: r.error }),
      seconds: (Date.now() - t) / 1000
    });
    return r;
  };

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  const { parseConfig } = uk("config");
  const { RequestQueue } = uk("route-service");
  const { planningApi } = uk("planning-api");
  const { PlanningBoxes } = uk("planning-box");
  const { workerRefresher, workerSurveyor, workerHeapLimitMb } = uk("build-process");
  const { autoCapKm } = uk("box-sizing");
  const { DEFAULT_WFS_URL } = uk("ingest/wfs");
  const config = parseConfig({});
  const box = await chartBox(config);
  const heapMb = workerHeapLimitMb();
  const capKm = autoCapKm(heapMb);
  const boxes = new PlanningBoxes({
    dir: path.join(WORK, "planning-box"),
    indexDir: path.join(WORK, "planning-index"),
    job: () => ({
      config: { url: DEFAULT_WFS_URL, radiusKm: 10, catzoc: 3 },
      index: () => box.index,
      leafZoom: config.leafZoom
    }),
    refresh: workerRefresher,
    survey: workerSurveyor,
    surveyDir: path.join(WORK, "planning-survey"),
    maxKm2: (2 * capKm) ** 2,
    boxBusy: () => false,
    clock: { now: Date.now, setInterval, clearInterval },
    debug: (m) => process.stdout.write(`     underkeel: ${m}\n`)
  });
  const deps = {
    index: box.index,
    indexReason: undefined,
    config,
    chartBox: () => box.bbox,
    vessel: () => ({ draft: DRAFT, length: 11, beam: 3.6 }),
    waterLevel: () => ({ h: 0, sigma: 0.2, source: "manual" }),
    waveHeight: () => undefined,
    getRoute: () => Promise.reject(new Error("none")),
    now: () => Date.now(),
    queue: new RequestQueue()
  };
  const base = planningApi(
    () => deps,
    "field trial",
    () => boxes
  );
  const log = [];
  const api = {
    ...base,
    survey: timed(log, "survey", base.survey),
    prepare: timed(log, "prepare", base.prepare)
  };
  let corridor;
  const prepare = api.prepare;
  api.prepare = (region, signal, parts) => {
    corridor = parts ?? corridor;
    return prepare(region, signal, parts);
  };
  const stop = new AbortController();
  const t0 = Date.now();
  // Waits for the whole build, as the panel's retries do.
  const prepared = await new Preparer(4 * 3_600_000).forTrip(api, FROM, TO, stop.signal, DRAFT);
  const prepareSeconds = (Date.now() - t0) / 1000;
  if (!("version" in prepared)) {
    throw new Error(
      `no index for the trip: ${JSON.stringify(prepared.body)} after ${JSON.stringify(log)}`
    );
  }
  const t1 = Date.now();
  const departure = Date.now();
  const reply = await plan(
    prepared,
    {
      from: FROM,
      to: TO,
      departure,
      speed: 3,
      draft: DRAFT,
      xteLimit: 10,
      accept: ["NOT_FOR_NAVIGATION"],
      fallback: true
    },
    stop.signal,
    Date.now(),
    // 50 nm is past the plan's default reach and work budget, which R2 does not change.
    { ...DEFAULT_PLAN, maxWork: 100_000_000, maxDistance: 120_000 }
  );
  const km2 = (b) =>
    (b[2] - b[0]) *
    111.195 *
    Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180) *
    (b[3] - b[1]) *
    111.195;
  const b = reply.body;
  const summary = {
    status: reply.status,
    ...(reply.status === 200
      ? { lengthNm: +(b.length / 1852).toFixed(2), legs: b.check.legs.length, work: b.work }
      : { reason: b.reason ?? (b.errors ?? []).join("; "), work: b.work }),
    distanceNm: +(
      require(path.join(ROOT, "lib", "foundation", "geo.js")).haversine(FROM, TO) / 1852
    ).toFixed(1),
    buildHeapMb: heapMb,
    planningBoxCapKm2: (2 * capKm) ** 2,
    corridor: corridor && {
      boxes: corridor.length,
      km2: Math.round(corridor.reduce((a, p) => a + km2(p), 0))
    },
    steps: log,
    prepareSeconds,
    planSeconds: (Date.now() - t1) / 1000,
    maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    cgroupPeakMb: cgroupPeakMb()
  };
  fs.writeFileSync(path.join(DATA, "r2-exit.json"), JSON.stringify({ summary, reply: b }, null, 2));
  if (reply.status === 200) {
    const c = b.route.coordinates;
    const features = b.check.legs.map((l, i) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [c[i], c[i + 1]] },
      properties: { leg: i, status: l.status, part: l.part }
    }));
    fs.writeFileSync(
      path.join(DATA, "r2-exit.geojson"),
      JSON.stringify({ type: "FeatureCollection", features })
    );
  }
  process.stdout.write(
    `${reply.status === 200 ? "PASS" : "FAIL"} r2-exit ${JSON.stringify(summary)}\n`
  );
  boxes.stop();
  process.exit(reply.status === 200 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`trial: ${err.stack ?? err}\n`);
  process.exit(2);
});
