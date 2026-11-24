import type { Plugin, PluginRouter, ServerAPI } from "@signalk/server-api";
import fs from "fs";
import path from "path";
import { mountAssets } from "./api/assets";
import { manifestProvider, PLUGIN_ID } from "./api/manifest";
import { registerRoutes } from "./api/routes";
import { publicReason } from "./foundation/public-text";
import type { PlanOptions } from "./plan/options";
import { DEFAULT_PLAN, WORK_SETTING, withWorkSetting } from "./plan/options";
import { budgetText, WorkRate } from "./plan/work-rate";
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

/** The plugin's settings (Signal K's plugin configuration). */
const SCHEMA = {
  type: "object",
  properties: {
    maxWork: {
      type: "integer",
      title: "Work budget per plan (signalk-underkeel work units)",
      description:
        "The work one plan may do at least; a longer trip may do more, in proportion to its distance. The plugin's status says what it takes on this machine once a plan of at least 100 000 work units has run.",
      default: DEFAULT_PLAN.maxWork,
      minimum: WORK_SETTING.min,
      maximum: WORK_SETTING.max
    },
    acceptNotForNavigation: {
      type: "boolean",
      title: "Plan on depth data marked not for navigation",
      description:
        "Such as the Traficom WFS depths. A leg on such data stays unverified, never ok. A request's own accept list takes its place.",
      default: false
    }
  }
};

/** The flags a plan accepts by the plugin's settings when its request names none. */
function acceptedBy(options: unknown): string[] {
  const on = (options as { acceptNotForNavigation?: unknown } | null | undefined)
    ?.acceptNotForNavigation;
  return on === true ? ["NOT_FOR_NAVIGATION"] : [];
}

function routePlanner(app: ServerAPI, clock: Clock = SYSTEM_CLOCK): Plugin {
  let running: AbortController | undefined;
  let limits: PlanOptions = DEFAULT_PLAN;
  let accept: string[] = [];
  const rate = new WorkRate();
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
      typeof api === "string"
        ? `Waiting: ${publicReason(api)}`
        : `Ready (${api.provider}) · ${budgetText(limits.maxWork, rate.secondsFor(limits.maxWork))}`;
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
    schema: () => SCHEMA,
    start(options: unknown): void {
      running?.abort(new Error("plugin restarted"));
      const setting = (options as { maxWork?: unknown } | null | undefined)?.maxWork;
      const chosen = withWorkSetting(DEFAULT_PLAN, setting);
      limits = chosen.opts;
      accept = acceptedBy(options);
      if (chosen.ignored !== undefined) {
        app.error(chosen.ignored);
      }
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
        apiFor(clock, () => running?.signal, undefined, {
          limits: () => limits,
          rate,
          planned: showStatus,
          note: (m) => app.debug(m),
          accept: () => accept
        }),
        (m) => app.error(m)
      );
    }
  };
}

export = routePlanner;
