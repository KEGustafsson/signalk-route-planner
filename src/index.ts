import type { Plugin, PluginRouter, ServerAPI } from "@signalk/server-api";
import fs from "fs";
import path from "path";
import { mountAssets } from "./api/assets";
import { manifestProvider, PLUGIN_ID } from "./api/manifest";
import { registerRoutes } from "./api/routes";
import { publicReason } from "./foundation/public-text";
import type { Clock } from "./plugin-api";
import { apiFor, ready, SYSTEM_CLOCK } from "./plugin-api";

// lib/index.js and src/index.ts both sit one level below package.json.
const VERSION = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

export = function routePlanner(app: ServerAPI, clock: Clock = SYSTEM_CLOCK): Plugin {
  let running: AbortController | undefined;
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
      const api = ready();
      app.setPluginStatus(
        typeof api === "string" ? `Waiting: ${publicReason(api)}` : `Ready (${api.provider})`
      );
    },
    stop(): void {
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
};
