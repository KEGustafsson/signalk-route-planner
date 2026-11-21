import type { Plugin, PluginRouter, ServerAPI } from "@signalk/server-api";
import fs from "fs";
import path from "path";
import { mountAssets } from "./api/assets";
import { manifestProvider, PLUGIN_ID } from "./api/manifest";
import { registerRoutes } from "./api/routes";
import { publicReason } from "./foundation/public-text";
import type { Clock } from "./plugin-api";
import { apiFor, ready, SYSTEM_CLOCK } from "./plugin-api";

/** How often the status is checked again while the planner waits for signalk-underkeel, ms. */
const STATUS_RECHECK_MS = 5000;

// lib/index.js and src/index.ts both sit one level below package.json.
const VERSION = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

function routePlanner(app: ServerAPI, clock: Clock = SYSTEM_CLOCK): Plugin {
  let running: AbortController | undefined;
  let recheck: NodeJS.Timeout | undefined;
  const stopRecheck = (): void => {
    clearInterval(recheck);
    recheck = undefined;
  };
  // Plugins start in no set order: signalk-underkeel may publish its API after this one starts.
  let shown: string | undefined;
  const showStatus = (): void => {
    const api = ready();
    const status =
      typeof api === "string" ? `Waiting: ${publicReason(api)}` : `Ready (${api.provider})`;
    if (status !== shown) {
      shown = status;
      app.setPluginStatus(status);
    }
    if (typeof api !== "string") {
      stopRecheck();
    }
  };
  return {
    id: PLUGIN_ID,
    name: "Safe-Water Route Planner",
    description:
      "Shortest route through water deep enough for the boat, checked by signalk-underkeel. Advisory only: not for navigation.",
    schema: () => ({ type: "object", properties: {} }),
    start(): void {
      running?.abort(new Error("plugin restarted"));
      running = new AbortController();
      mountAssets(app);
      app.registerResourceProvider(manifestProvider(VERSION));
      stopRecheck();
      shown = undefined;
      recheck = setInterval(showStatus, STATUS_RECHECK_MS);
      recheck.unref();
      showStatus();
    },
    stop(): void {
      stopRecheck();
      running?.abort(new Error("plugin stopped"));
      running = undefined;
    },
    registerWithRouter(router: PluginRouter): void {
      registerRoutes(
        router,
        apiFor(clock, () => running?.signal),
        (m) => app.error(m)
      );
    }
  };
}

export = routePlanner;
