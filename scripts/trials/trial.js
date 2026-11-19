#!/usr/bin/env node
"use strict";

// Field trials (docs/trials.md): plans the cases in trials.json on real chart data with
// signalk-underkeel's planning API, and checks each result against its expectation.
//
//   node scripts/trials/trial.js [--profile] [case-or-area ...]
//
// --profile prints, per case, where the work went: box and leg queries by size, and how many
// boxes and legs came back ok, so a change to the search can be measured against the work budget.
//
// Needs network (Traficom WFS, NOAA ENC downloads, cached under data/trials/), this package
// built (`npm run build`), and a built signalk-underkeel 0.7.0 or later checkout next to this
// one or at UNDERKEEL_DIR. Not part of `npm test`, which stays hermetic.
// Writes data/trials/<case>.json (the reply) and <case>.geojson (legs with their statuses).
// Exits 1 when a result does not meet its expectation.

const fs = require("fs");
const path = require("path");
const { unzip } = require("./unzip");

const ROOT = path.resolve(__dirname, "..", "..");
const UK = path.join(
  path.resolve(process.env.UNDERKEEL_DIR ?? path.join(ROOT, "..", "signalk-underkeel")),
  "lib"
);
const DATA = path.resolve(process.env.TRIALS_DIR ?? path.join(ROOT, "data", "trials"));
const NOAA = "https://charts.noaa.gov/ENCs";
const PROFILE = process.argv.includes("--profile");

const need = (p) => {
  if (!fs.existsSync(p)) {
    throw new Error(`${p} is missing: build it first (npm run build there)`);
  }
  return require(p);
};
const uk = (m) => need(path.join(UK, `${m}.js`));
const { plan } = need(path.join(ROOT, "lib", "plan", "plan.js"));
const { DEFAULT_PLAN } = need(path.join(ROOT, "lib", "plan", "options.js"));

async function noaaCells(area) {
  const files = [];
  for (const cell of area.cells) {
    const dir = path.join(DATA, "miami", cell);
    const base = path.join(dir, `${cell}.000`);
    if (!fs.existsSync(base)) {
      const res = await fetch(`${NOAA}/${cell}.zip`);
      if (!res.ok) {
        throw new Error(`${NOAA}/${cell}.zip: HTTP ${res.status}`);
      }
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, bytes] of unzip(Buffer.from(await res.arrayBuffer()))) {
        if (name.includes(`/${cell}/`)) {
          fs.writeFileSync(path.join(dir, path.basename(name)), bytes);
        }
      }
    }
    files.push(base);
  }
  return files;
}

async function wfsCell(area, catzoc) {
  const { downloadWfsCell, DEFAULT_WFS_URL } = uk("ingest/wfs");
  const dir = path.join(DATA, "turku", `catzoc-${catzoc}`, "FI1WFS01");
  if (!fs.existsSync(path.join(dir, "DEPARE.geojson"))) {
    await downloadWfsCell({
      fetch: (url, init) => fetch(url, init),
      url: DEFAULT_WFS_URL,
      bbox: area.bbox,
      dir,
      now: new Date(),
      catzoc
    });
  }
  return [dir];
}

const indexes = new Map();

/** The chart index for an area (and assumed CATZOC), built once. */
async function indexFor(areas, c) {
  const key = `${c.area}:${c.catzoc ?? ""}`;
  if (!indexes.has(key)) {
    const area = areas[c.area];
    const sources =
      area.source === "noaa-enc" ? await noaaCells(area) : await wfsCell(area, c.catzoc ?? 3);
    const { readCell } = uk("ingest/cell-source");
    const cells = [];
    for (const [i, s] of sources.entries()) {
      cells.push(await readCell(s, i));
    }
    indexes.set(key, uk("spatial/chart-index").buildChartIndex(cells, { leafZoom: 20 }));
  }
  return indexes.get(key);
}

/**
 * The water level over [start, end], at its lowest: chart datum, or a case's modelled tide,
 * mean + amplitude · cos(2π (t − high water) / period), sampled every 5 minutes.
 */
function waterLevel(tide, departure) {
  if (!tide) {
    return () => ({ h: 0, sigma: 0.2, source: "manual" });
  }
  const high = departure + tide.highWaterHours * 3_600_000;
  const at = (t) =>
    tide.mean +
    tide.amplitude * Math.cos((2 * Math.PI * (t - high)) / (tide.periodHours * 3_600_000));
  return (start, end) => {
    let h = at(end);
    for (let t = start; t < end; t += 300_000) {
      h = Math.min(h, at(t));
    }
    return { h, sigma: 0.2, source: "trial tide" };
  };
}

function apiFor(index, draft, tide, departure) {
  const { parseConfig } = uk("config");
  const { RequestQueue } = uk("route-service");
  const { planningApi } = uk("planning-api");
  const deps = {
    index,
    indexReason: undefined,
    config: parseConfig({}),
    vessel: () => ({ draft, length: 11, beam: 3.6 }),
    // Chart datum, σ 0.2 m, unless the case models a tide: the trials do not depend on the day.
    waterLevel: waterLevel(tide, departure),
    waveHeight: () => undefined,
    getRoute: () => Promise.reject(new Error("none")),
    now: () => Date.now(),
    queue: new RequestQueue()
  };
  return planningApi(() => deps, "field trial");
}

/** The work behind each box and leg query, bucketed by size, while `profile` is set. */
function profiled(api, profile) {
  const bucket = (metres) =>
    metres < 50 ? "<50 m" : metres < 200 ? "<200 m" : metres < 1000 ? "<1 km" : ">=1 km";
  const add = (key, work, passed) => {
    const e = (profile[key] ??= { calls: 0, work: 0, passed: 0 });
    e.calls++;
    e.work += work;
    e.passed += passed ? 1 : 0;
  };
  const side = (sw, ne) =>
    Math.max(
      Math.abs(ne[1] - sw[1]) * 111_200,
      Math.abs(ne[0] - sw[0]) * 111_200 * Math.cos((sw[1] * Math.PI) / 180)
    );
  // A leg's own length, east and north together; a box by its longer side.
  const length = (a, b) =>
    Math.hypot(
      (b[1] - a[1]) * 111_200,
      (b[0] - a[0]) * 111_200 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
    );
  return {
    ...api,
    session: (params, signal, job) =>
      api.session(params, signal, async (s) => {
        const r = await job({
          halfWidth: s.halfWidth,
          box: (sw, ne, w) => {
            const before = s.work();
            const v = s.box(sw, ne, w);
            add(`box ${bucket(side(sw, ne))}`, s.work() - before, v.status === "ok");
            return v;
          },
          segment: (a, b, w) => {
            const before = s.work();
            const v = s.segment(a, b, w);
            add(`leg ${bucket(length(a, b))}`, s.work() - before, v.status === "ok");
            return v;
          },
          work: () => s.work(),
          pause: () => s.pause()
        });
        const stage = `session xte ${params.xteLimit ?? "default"}`;
        const e = (profile[stage] ??= { calls: 0, work: 0, passed: 0 });
        e.calls++;
        e.work += s.work();
        return r;
      })
  };
}

function summarise(reply) {
  const b = reply.body;
  if (reply.status !== 200) {
    return { status: reply.status, reason: b.reason ?? (b.errors ?? []).join("; "), work: b.work };
  }
  const legs = b.check.legs;
  const parts = b.check.parts.map((p) => (p.end ? `${p.part}:${p.end}` : p.part));
  const count = {};
  for (const l of legs) {
    const k = `${l.part}${l.berth ? "/berth" : ""} ${l.status}`;
    count[k] = (count[k] ?? 0) + 1;
  }
  return {
    status: 200,
    lengthNm: +(b.length / 1852).toFixed(2),
    legs: legs.length,
    parts,
    statuses: count,
    berths: (b.berths ?? []).length,
    ...(b.gate && { waitMinutes: b.gate.waitMinutes }),
    work: b.work
  };
}

function failures(s, e, reply) {
  const out = [];
  if (s.status !== e.status) {
    out.push(`status ${s.status}, expected ${e.status}`);
  }
  if (e.gate && !((reply.body.gate ?? {}).reason ?? "").includes(e.gate)) {
    out.push(`gate does not say "${e.gate}"`);
  }
  if (e.workAtMost !== undefined && (s.work ?? 0) > e.workAtMost) {
    out.push(`work ${s.work} over ${e.workAtMost}`);
  }
  if (e.reason && !(s.reason ?? "").includes(e.reason)) {
    out.push(`reason does not name "${e.reason}"`);
  }
  if (
    e.lengthNm &&
    s.status === 200 &&
    (s.lengthNm < e.lengthNm[0] || s.lengthNm > e.lengthNm[1])
  ) {
    out.push(`length ${s.lengthNm} nm outside ${e.lengthNm.join("–")}`);
  }
  if (e.parts && s.status === 200 && s.parts.join(",") !== e.parts.join(",")) {
    out.push(`parts ${s.parts.join(",")}, expected ${e.parts.join(",")}`);
  }
  if (e.routeStatuses && s.status === 200) {
    const bad = reply.body.check.legs.filter(
      (l) => l.part === "route" && !e.routeStatuses.includes(l.status)
    );
    if (bad.length > 0) {
      out.push(`${bad.length} route legs outside ${e.routeStatuses.join("/")}`);
    }
  }
  return out;
}

function geojson(reply) {
  const b = reply.body;
  if (reply.status !== 200) {
    return { type: "FeatureCollection", features: [] };
  }
  const c = b.route.coordinates;
  return {
    type: "FeatureCollection",
    features: b.check.legs.map((l, i) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [c[i], c[i + 1]] },
      properties: {
        leg: i,
        status: l.status,
        risk: l.risk,
        part: l.part,
        berth: l.berth === true,
        flags: l.flags
      }
    }))
  };
}

async function main() {
  const { areas, cases } = JSON.parse(fs.readFileSync(path.join(__dirname, "trials.json"), "utf8"));
  const pick = process.argv.slice(2).filter((a) => a !== "--profile");
  const unknown = pick.filter((sel) => !cases.some((c) => c.name === sel || c.area === sel));
  if (unknown.length > 0) {
    throw new Error(`no trial case or area named ${unknown.join(", ")}`);
  }
  const run = cases.filter(
    (c) => pick.length === 0 || pick.includes(c.name) || pick.includes(c.area)
  );
  fs.mkdirSync(DATA, { recursive: true });
  let bad = 0;
  for (const c of run) {
    const profile = {};
    const departure = Date.now();
    const base = apiFor(await indexFor(areas, c), c.draft, c.tide, departure);
    const api = PROFILE ? profiled(base, profile) : base;
    const t = Date.now();
    const reply = await plan(
      api,
      {
        from: c.from,
        to: c.to,
        departure,
        ...(c.waitHours && { latestDeparture: departure + c.waitHours * 3_600_000 }),
        speed: 3,
        draft: c.draft,
        xteLimit: c.xteLimit,
        ...(c.accept && { accept: c.accept }),
        ...(c.fallback && { fallback: true })
      },
      new AbortController().signal,
      Date.now(),
      // The trials measure what the search finds; R2 brings the work into the Pi budget.
      { ...DEFAULT_PLAN, maxWork: c.maxWork ?? 100_000_000 }
    );
    const s = { ...summarise(reply), seconds: +((Date.now() - t) / 1000).toFixed(1) };
    fs.writeFileSync(path.join(DATA, `${c.name}.json`), JSON.stringify(reply.body, null, 2));
    fs.writeFileSync(path.join(DATA, `${c.name}.geojson`), JSON.stringify(geojson(reply)));
    const f = failures(s, c.expect, reply);
    bad += f.length > 0 ? 1 : 0;
    process.stdout.write(`${f.length === 0 ? "PASS" : "FAIL"} ${c.name} ${JSON.stringify(s)}\n`);
    for (const why of f) {
      process.stdout.write(`     ${why}\n`);
    }
    if (PROFILE) {
      for (const [k, e] of Object.entries(profile).sort((a, b) => b[1].work - a[1].work)) {
        process.stdout.write(
          `     ${k.padEnd(14)} ${String(e.calls).padStart(7)} calls ${String(e.work).padStart(11)} work, ${e.passed} ok\n`
        );
      }
    }
  }
  process.exit(bad > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`trial: ${err.stack ?? err}\n`);
  process.exit(2);
});
