"use strict";

// Where a plan's work goes (`--profile` in the field trials): the work behind each box and leg
// query, bucketed by size, how many came back ok, and each planning session's total.

const bucket = (metres) =>
  metres < 50 ? "<50 m" : metres < 200 ? "<200 m" : metres < 1000 ? "<1 km" : ">=1 km";

/** A box's longer side, metres. */
const side = (sw, ne) =>
  Math.max(
    Math.abs(ne[1] - sw[1]) * 111_200,
    Math.abs(ne[0] - sw[0]) * 111_200 * Math.cos((sw[1] * Math.PI) / 180)
  );

/** A leg's own length, east and north together. */
const length = (a, b) =>
  Math.hypot(
    (b[1] - a[1]) * 111_200,
    (b[0] - a[0]) * 111_200 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
  );

/**
 * `api` with its sessions' queries counted into `profile`. `where(sw, ne)`, when given, names
 * where a box lies (as the R2 trial names it against its corridor) and splits its buckets by it.
 */
function profiled(api, profile, where) {
  const add = (key, work, passed) => {
    const e = (profile[key] ??= { calls: 0, work: 0, passed: 0 });
    e.calls++;
    e.work += work;
    e.passed += passed ? 1 : 0;
  };
  return {
    ...api,
    session: (params, signal, job) =>
      api.session(params, signal, async (s) => {
        const r = await job({
          halfWidth: s.halfWidth,
          box: (sw, ne, w) => {
            const before = s.work();
            const v = s.box(sw, ne, w);
            const at = where ? ` ${where(sw, ne)}` : "";
            add(`box ${bucket(side(sw, ne))}${at}`, s.work() - before, v.status === "ok");
            return v;
          },
          segment: (a, b, w) => {
            const before = s.work();
            const v = s.segment(a, b, w);
            add(`leg ${bucket(length(a, b))}`, s.work() - before, v.status === "ok");
            return v;
          },
          ...(s.objects && { objects: (sw, ne) => s.objects(sw, ne) }),
          ...(s.raster && {
            rasterZoom: s.rasterZoom,
            raster: (x0, y0, cols, rows) => {
              const before = s.work();
              const r = s.raster(x0, y0, cols, rows);
              add("raster block", s.work() - before, false);
              return r;
            }
          }),
          work: () => s.work(),
          pause: () => s.pause(),
          ...(s.within && { within: s.within })
        });
        const stage = `session xte ${params.xteLimit ?? "default"}`;
        const e = (profile[stage] ??= { calls: 0, work: 0, passed: 0 });
        e.calls++;
        e.work += s.work();
        return r;
      })
  };
}

/** Writes `profile`, the most work first. */
function printProfile(profile, out = process.stdout) {
  for (const [k, e] of Object.entries(profile).sort((a, b) => b[1].work - a[1].work)) {
    out.write(
      `     ${k.padEnd(20)} ${String(e.calls).padStart(7)} calls ${String(e.work).padStart(11)} work, ${e.passed} ok\n`
    );
  }
}

module.exports = { profiled, printProfile };
