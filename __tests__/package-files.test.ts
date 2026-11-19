import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(__dirname, "..");

interface Packed {
  files: { path: string }[];
}

/**
 * The files `npm pack` would publish. The plugin registry runs the tests with
 * a read-only home, where npm cannot write its cache, so it gets its own.
 */
function packedFiles(): string[] {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "planner-npm-cache-"));
  try {
    const out = execSync("npm pack --dry-run --json --ignore-scripts", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, npm_config_cache: cache }
    });
    return ((JSON.parse(out) as Packed[])[0]?.files ?? []).map((f) => f.path);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

describe("published package", () => {
  const packed = packedFiles();

  test("ships the panel pages and the changelog, and no source, test or script", () => {
    for (const f of [
      "public/panel.html",
      "public/panel.js",
      "public/planner-shared.js",
      "CHANGELOG.md"
    ]) {
      expect(packed).toContain(f);
    }
    expect(packed.filter((f) => /^(src|scripts|__tests__|\.claude)\//.test(f))).toEqual([]);
  });
});
