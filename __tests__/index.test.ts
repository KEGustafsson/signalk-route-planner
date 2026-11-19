import routePlanner = require("../src/index");
import { buildManifest, PLUGIN_ID } from "../src/api/manifest";
import { PLANNING_API } from "../src/oracle/contract";
import { syntheticApi } from "./helpers/synthetic-oracle";

/** Plugin lifecycle: status at start, the manifest, and plans refused once stopped. */

const g = globalThis as unknown as Record<symbol, unknown>;

function fakeApp() {
  const statuses: string[] = [];
  const providers: { type: string }[] = [];
  const app = {
    setPluginStatus: (s: string) => statuses.push(s),
    registerResourceProvider: (p: { type: string }) => providers.push(p),
    error: () => undefined,
    use: () => undefined
  };
  return { app, statuses, providers };
}

describe("plugin lifecycle", () => {
  afterEach(() => {
    delete g[PLANNING_API];
  });

  test("without signalk-underkeel the status says what it waits for", () => {
    const f = fakeApp();
    const plugin = routePlanner(f.app as never);
    plugin.start({}, () => undefined);
    expect(f.statuses).toEqual([
      expect.stringMatching(/^Waiting: signalk-underkeel 0.7.0 or later/)
    ]);
    expect(f.providers.map((p) => p.type)).toEqual(["plotterExtensions"]);
    plugin.stop();
  });

  test("with the planning API ready the status names its provider", () => {
    g[PLANNING_API] = syntheticApi({ obstacles: [] });
    const f = fakeApp();
    const plugin = routePlanner(f.app as never);
    plugin.start({}, () => undefined);
    expect(f.statuses).toEqual(["Ready (synthetic)"]);
    plugin.stop();
  });

  test("the manifest asks for panels and routes and opens the panel from the toolbar", () => {
    const m = buildManifest("1.2.3")[PLUGIN_ID];
    expect(m?.requires).toEqual(["panels.iframe", "routes"]);
    expect(m?.buttons[0]?.action).toEqual({ type: "togglePanel", panel: "planner" });
    expect(m?.version).toBe("1.2.3");
  });
});
