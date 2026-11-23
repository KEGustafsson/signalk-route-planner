import routePlanner = require("../src/index");
import { buildManifest, PLUGIN_ID } from "../src/api/manifest";
import { PLANNING_API } from "../src/oracle/contract";
import { syntheticApi } from "./helpers/synthetic-oracle";

/** Plugin lifecycle: status at start, the manifest, and plans refused once stopped. */

const g = globalThis as unknown as Record<symbol, unknown>;

function fakeApp() {
  const statuses: string[] = [];
  const errors: string[] = [];
  const providers: { type: string }[] = [];
  const app = {
    setPluginStatus: (s: string) => statuses.push(s),
    registerResourceProvider: (p: { type: string }) => providers.push(p),
    error: (m: string) => errors.push(m),
    use: () => undefined
  };
  return { app, statuses, errors, providers };
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

  test("signalk-underkeel starting after the planner turns the status to ready", () => {
    jest.useFakeTimers();
    try {
      const f = fakeApp();
      const plugin = routePlanner(f.app as never);
      plugin.start({}, () => undefined);
      jest.advanceTimersByTime(20_000);
      expect(f.statuses).toHaveLength(1);
      g[PLANNING_API] = syntheticApi({ obstacles: [] });
      jest.advanceTimersByTime(5_000);
      expect(f.statuses.at(-1)).toBe("Ready (synthetic) · 1.2 M work units");
      jest.advanceTimersByTime(20_000);
      expect(f.statuses).toHaveLength(2);
      plugin.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("with the planning API ready the status names its provider", () => {
    g[PLANNING_API] = syntheticApi({ obstacles: [] });
    const f = fakeApp();
    const plugin = routePlanner(f.app as never);
    plugin.start({}, () => undefined);
    expect(f.statuses).toEqual(["Ready (synthetic) · 1.2 M work units"]);
    plugin.stop();
  });

  test("the work budget setting is the plan's, and one out of range is reported and not used", () => {
    g[PLANNING_API] = syntheticApi({ obstacles: [] });
    const f = fakeApp();
    const plugin = routePlanner(f.app as never);
    const schema = plugin.schema as () => unknown;
    expect(schema()).toMatchObject({
      properties: {
        maxWork: { type: "integer", default: 1_200_000 },
        acceptNotForNavigation: { type: "boolean", default: false }
      }
    });
    plugin.start({ maxWork: 2_500_000 }, () => undefined);
    expect(f.statuses.at(-1)).toBe("Ready (synthetic) · 2.5 M work units");
    plugin.start({ maxWork: 5 }, () => undefined);
    expect(f.statuses.at(-1)).toBe("Ready (synthetic) · 1.2 M work units");
    expect(f.errors).toEqual([expect.stringMatching(/work budget must be a whole number/)]);
    plugin.stop();
  });

  test("the manifest asks for panels and routes and opens the panel from the toolbar", () => {
    const m = buildManifest("1.2.3")[PLUGIN_ID];
    expect(m?.requires).toEqual(["panels.iframe", "routes"]);
    expect(m?.buttons[0]?.action).toEqual({ type: "togglePanel", panel: "planner" });
    expect(m?.version).toBe("1.2.3");
  });
});
