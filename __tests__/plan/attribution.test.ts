import type { LonLat } from "../../src/foundation/geo";
import {
  attributionsOf,
  FTIA,
  ftiaLinesAbout,
  keepsTo,
  TRAFICOM
} from "../../src/plan/attribution";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { plan } from "../../src/plan/plan";
import type { Chart } from "../helpers/synthetic-oracle";
import { at, syntheticApi } from "../helpers/synthetic-oracle";

/**
 * Data attributions (plan §5): a reply credits the FTIA when its route kept to an FTIA navigation
 * line (`NAVLINE`), and Traficom when a leg crossed its WFS depths (`NOT_FOR_NAVIGATION`); a
 * route that used neither credits none.
 */

const NEVER = new AbortController().signal;
const NOW = Date.parse("2026-11-18T07:00:00Z");

/** A line from the start up to (2000, h) and down to the destination, of class `cls`. */
const bent = (cls: string, h = 300): Chart => ({
  obstacles: [],
  lines: [
    {
      class: cls,
      points: [
        [0, 0],
        [2000, h],
        [4000, 0]
      ]
    }
  ]
});

async function credits(chart: Chart, over: object = {}) {
  const r = await plan(
    syntheticApi(chart, { features: ["objects"] }),
    { from: at(0, 0), to: at(4000, 0), departure: NOW, speed: 3, preferLines: true, ...over },
    NEVER,
    NOW,
    DEFAULT_PLAN
  );
  expect(r.status).toBe(200);
  return (r.body as { attributions: unknown[] }).attributions;
}

describe("keepsTo", () => {
  const line: LonLat[] = [at(0, 50), at(4000, 50)];

  test("a route along a line within its reach keeps to it", () => {
    expect(keepsTo([at(0, 0), at(4000, 0)], [line], 60)).toBe(true);
  });

  test("a route past a line's reach, or only crossing it, does not keep to it", () => {
    expect(keepsTo([at(0, 0), at(4000, 0)], [line], 40)).toBe(false);
    expect(keepsTo([at(0, 0), at(4000, 0)], [], 60)).toBe(false);
    expect(keepsTo([at(0, 0), at(4000, 0)], [[at(2000, -500), at(2000, 500)]], 30)).toBe(false);
  });
});

describe("attributionsOf", () => {
  test("Traficom only for a leg flagged NOT_FOR_NAVIGATION", () => {
    const route = [at(0, 0), at(1000, 0)];
    expect(attributionsOf(route, [{ flags: [] }], [], 50)).toEqual([]);
    expect(attributionsOf(route, [{ flags: ["NOT_FOR_NAVIGATION"] }], [], 50)).toEqual([TRAFICOM]);
  });
});

describe("ftiaLinesAbout", () => {
  const params = { departure: NOW, until: NOW + 3_600_000, speed: 3 };
  const route = [at(0, 0), at(4000, 0)];

  test("lists the FTIA lines about the route, and no other class", async () => {
    const chart: Chart = {
      obstacles: [],
      lines: [
        {
          class: "NAVLINE",
          points: [
            [0, 20],
            [4000, 20]
          ]
        },
        {
          class: "NAVLNE",
          points: [
            [0, -20],
            [4000, -20]
          ]
        }
      ]
    };
    const api = syntheticApi(chart, { features: ["objects"] });
    expect(await ftiaLinesAbout(api, params, route, 50, NEVER)).toHaveLength(1);
  });

  test("a provider without objects has none; a session that fails cannot tell", async () => {
    expect(await ftiaLinesAbout(syntheticApi(bent("NAVLINE")), params, route, 50, NEVER)).toEqual(
      []
    );
    const failing = syntheticApi(bent("NAVLINE"), {
      features: ["objects"],
      session: () => Promise.resolve({ ok: false, status: 503, error: "busy" })
    });
    expect(await ftiaLinesAbout(failing, params, route, 50, NEVER)).toBeUndefined();
  });
});

describe("a plan's attributions", () => {
  test("a route that kept to an FTIA navigation line credits the FTIA", async () => {
    expect(await credits(bent("NAVLINE"))).toEqual([FTIA]);
  });

  test("a leading line of an ENC cell credits no one", async () => {
    expect(await credits(bent("NAVLNE"))).toEqual([]);
  });

  test("without preferLines no FTIA line is kept to, so none is credited", async () => {
    expect(await credits(bent("NAVLINE"), { preferLines: false })).toEqual([]);
  });

  test("an FTIA line the route only meets at its start credits no one", async () => {
    expect(await credits(bent("NAVLINE", 3000))).toEqual([]);
  });

  test("lines that cannot be listed leave the FTIA credited, as a route that may keep to them", async () => {
    const api = syntheticApi(bent("NAVLINE"), { features: ["objects"] });
    const session = api.session.bind(api);
    api.session = (params, signal, job) =>
      session(params, signal, (s) =>
        job({
          ...s,
          objects: () => {
            throw new RangeError("objects box over 40000 km²");
          }
        })
      );
    const r = await plan(
      api,
      { from: at(0, 0), to: at(4000, 0), departure: NOW, speed: 3, preferLines: true },
      NEVER,
      NOW
    );
    expect((r.body as { attributions: unknown[] }).attributions).toEqual([FTIA]);
  });

  test("depths marked not for navigation credit Traficom", async () => {
    expect(
      await credits({ obstacles: [], notForNavigation: true }, { accept: ["NOT_FOR_NAVIGATION"] })
    ).toEqual([TRAFICOM]);
  });

  test("each alternative credits what its own route leaned on", async () => {
    const r = await plan(
      syntheticApi(bent("NAVLINE"), { features: ["objects"] }),
      {
        from: at(0, 0),
        to: at(4000, 0),
        departure: NOW,
        speed: 3,
        preferLines: true,
        alternatives: true
      },
      NEVER,
      NOW,
      DEFAULT_PLAN
    );
    const body = r.body as {
      attributions: unknown[];
      alternatives: { attributions?: unknown[] }[];
    };
    expect(body.attributions).toEqual([FTIA]);
    expect(body.alternatives.every((a) => Array.isArray(a.attributions))).toBe(true);
  });
});
