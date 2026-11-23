import fs from "fs";
import os from "os";
import path from "path";
import { assetFile, assetMiddleware, mountAssets } from "../../src/api/assets";
import { buildManifest, PLUGIN_ID } from "../../src/api/manifest";

const PUBLIC = path.resolve(__dirname, "..", "..", "public");

function serve(
  p: string,
  method = "GET",
  reqHeaders: Record<string, string> = {},
  mw = assetMiddleware(PUBLIC)
) {
  let next = false;
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: (k: string, v: string) => (headers[k] = v),
    end(b?: unknown) {
      this.body = b;
    }
  };
  mw({ method, path: p, headers: reqHeaders }, res, () => (next = true));
  return { next, headers, res };
}

describe("extension assets", () => {
  test("every page the manifest names exists in public/", () => {
    const m = buildManifest("0")[PLUGIN_ID];
    const urls = (m?.panels ?? []).map((c) => c.url);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const rel = url.replace(`/plotterext/${PLUGIN_ID}/`, "");
      expect(fs.existsSync(path.join(PUBLIC, rel))).toBe(true);
    }
  });

  test("files are served with their type and no-cache; anything else falls through", () => {
    const page = serve("/panel.html");
    expect(page.next).toBe(false);
    expect(page.res.statusCode).toBe(200);
    expect(page.headers["Content-Type"]).toMatch(/text\/html/);
    expect(page.headers["Cache-Control"]).toBe("no-cache");
    expect(serve("/missing.html").next).toBe(true);
    expect(serve("/panel.html", "POST").next).toBe(true);
  });

  test("a page the browser already holds is answered 304 by its ETag, a changed one in full", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "planner-assets-"));
    const file = path.join(root, "panel.js");
    fs.writeFileSync(file, "one");
    const mw = assetMiddleware(root);
    const first = serve("/panel.js", "GET", {}, mw);
    const etag = first.headers.ETag as string;
    expect(first.res.statusCode).toBe(200);
    expect(etag).toMatch(/^"[^"]+"$/);
    expect(String(first.res.body)).toBe("one");
    for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const again = serve("/panel.js", "GET", { "if-none-match": inm }, mw);
      expect(again.res.statusCode).toBe(304);
      expect(again.res.body).toBeUndefined();
      expect(again.headers.ETag).toBe(etag);
      expect(again.headers["Cache-Control"]).toBe("no-cache");
    }
    expect(serve("/panel.js", "HEAD", { "if-none-match": etag }, mw).res.statusCode).toBe(304);
    fs.writeFileSync(file, "two, longer");
    const changed = serve("/panel.js", "GET", { "if-none-match": etag }, mw);
    expect(changed.res.statusCode).toBe(200);
    expect(String(changed.res.body)).toBe("two, longer");
    expect(changed.headers.ETag).not.toBe(etag);
    expect(serve("/panel.js", "GET", { "if-none-match": '"stale"' }, mw).res.statusCode).toBe(200);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("a same-size replacement that keeps the mtime is served afresh", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "planner-assets-"));
    const file = path.join(root, "panel.js");
    fs.writeFileSync(file, "one");
    const mw = assetMiddleware(root);
    const first = serve("/panel.js", "GET", {}, mw);
    const { atime, mtime } = fs.statSync(file);
    const next = path.join(root, "panel.js.new");
    fs.writeFileSync(next, "two");
    fs.renameSync(next, file);
    fs.utimesSync(file, atime, mtime);
    const replaced = serve("/panel.js", "GET", {}, mw);
    expect(String(replaced.res.body)).toBe("two");
    expect(replaced.headers.ETag).not.toBe(first.headers.ETag);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("paths outside public/ and unknown file types are refused", () => {
    expect(assetFile(PUBLIC, "/../package.json")).toBeUndefined();
    expect(assetFile(PUBLIC, "/%2e%2e/package.json")).toBeUndefined();
    expect(assetFile(PUBLIC, "/%E0%A4%A")).toBeUndefined();
    expect(assetFile(PUBLIC, "/panel%00.html")).toBeUndefined();
    expect(assetFile(PUBLIC, "/planner-shared.js")).toBe(path.join(PUBLIC, "planner-shared.js"));
  });

  test("a NUL byte in the path falls through instead of throwing", () => {
    for (const p of ["/x%00.html", "/panel.html%00.js"]) {
      expect(serve(p).next).toBe(true);
    }
  });

  test("a name fs fails on falls through instead of a 500 with the stack", () => {
    // Too long for the file system: statSync throws ENAMETOOLONG instead of returning nothing.
    const long = `/${"a".repeat(300)}.html`;
    expect(serve(long).next).toBe(true);
    expect(serve(long, "HEAD").next).toBe(true);
    expect(assetFile(PUBLIC, long)).toBeUndefined();
  });

  test("the pages are mounted once per server app", () => {
    const mounts: string[] = [];
    const app = { use: (prefix: string) => mounts.push(prefix) };
    mountAssets(app);
    mountAssets(app);
    expect(mounts).toEqual([`/plotterext/${PLUGIN_ID}`]);
  });

  test("the manifest offers routePlan at the plugin's REST base, and no map overlay", () => {
    const m = buildManifest("0")[PLUGIN_ID];
    expect(m?.services.navigationSafety).toEqual({
      apiVersion: "1",
      base: "/plugins/signalk-route-planner/v1",
      provides: ["routePlan"]
    });
    expect(m).not.toHaveProperty("overlays");
    expect(m?.optional).not.toContain("overlays.data");
  });
});
