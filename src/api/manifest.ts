import type { ResourceProvider } from "@signalk/server-api";

/**
 * Plotter Extensions manifest contribution (plan §4.5): a panel that plans a
 * route between the ends of a selected route, or from the boat, and writes it
 * back as an unsaved draft, a toolbar button that opens it, and `routePlan` in
 * the navigationSafety services. The pages are served
 * from ASSET_BASE (see assets.ts).
 */

export const PLUGIN_ID = "signalk-route-planner";

/** Where the extension pages are served; outside /plugins, which needs an admin login. */
export const ASSET_BASE = `/plotterext/${PLUGIN_ID}`;

export interface Manifest {
  name: string;
  description: string;
  version: string;
  apiVersion: "1";
  requires: string[];
  optional: string[];
  panels: { id: string; title: string; type: "iframe"; url: string; lifecycle: "onOpen" }[];
  buttons: {
    id: string;
    title: string;
    slot: "mapToolbar";
    icon: string;
    action: { type: "togglePanel"; panel: string };
  }[];
  /**
   * The provider-neutral services Freeboard calls (plan §4.5): `routePlan` is `POST {base}/plan`
   * with the request and reply of plan §5.
   */
  services: { navigationSafety: { apiVersion: "1"; base: string; provides: ["routePlan"] } };
}

/** The plugin's REST base, outside the pages: it needs a login where the server is secured. */
export const API_BASE = `/plugins/${PLUGIN_ID}/v1`;

export function buildManifest(version: string): Record<string, Manifest> {
  return {
    [PLUGIN_ID]: {
      name: "Safe-Water Route Planner",
      description:
        "Plans the shortest route through water deep enough for the boat, checked by signalk-underkeel. Advisory: always use an official chart.",
      version,
      apiVersion: "1",
      requires: ["panels.iframe", "routes"],
      optional: ["buttons", "nightMode", "signalk.stream", "x-freeboard.services.navigationSafety"],
      panels: [
        {
          id: "planner",
          title: "Route planner",
          type: "iframe",
          url: `${ASSET_BASE}/panel.html`,
          lifecycle: "onOpen"
        }
      ],
      buttons: [
        {
          id: "open-planner",
          title: "Route planner",
          slot: "mapToolbar",
          icon: "alt_route",
          action: { type: "togglePanel", panel: "planner" }
        }
      ],
      services: {
        navigationSafety: { apiVersion: "1", base: API_BASE, provides: ["routePlan"] }
      }
    }
  };
}

/** Read-only resource provider serving the manifest as `plotterExtensions` resources. */
export function manifestProvider(version: string): ResourceProvider {
  const manifest = buildManifest(version);
  const readOnly = (): Promise<void> =>
    Promise.reject(new Error("plotterExtensions resources are read-only"));
  return {
    type: "plotterExtensions",
    methods: {
      listResources: () => Promise.resolve(manifest),
      getResource: (id: string) => {
        const m = Object.hasOwn(manifest, id) ? manifest[id] : undefined;
        return m
          ? Promise.resolve(m as unknown as object)
          : Promise.reject(new Error(`no plotterExtensions resource ${id}`));
      },
      setResource: readOnly,
      deleteResource: readOnly
    }
  };
}
