# Changelog

All notable changes to signalk-route-planner are documented here.

## [0.1.0]

### Added

- `POST /plan`: the shortest route through water signalk-underkeel's route check passes, between
  a start and a destination up to 60 km apart. The straight line is tried first; otherwise a
  quadtree of the region classified through signalk-underkeel's planning API v1, A\* through its
  free squares and string pulling. The final route is checked by signalk-underkeel's route
  check, and its leg statuses are the plan's; without `fallback`, a route the check does not pass
  at the departure is refused with the check's legs.
- A Freeboard-SK panel, opened from the map toolbar, that plans between the ends of a visible
  route and writes the plan into it as an unsaved change.
- `GET /status`, and a plugin status that names what the planner waits for.
- `accept: ["NOT_FOR_NAVIGATION"]`: plan on depth data marked not for navigation, such as the
  Traficom WFS; every such leg stays `unverified`.
- `fallback: true`: when no route passes, the lowest risk-weighted route through charted water, never over
  land, with its risky legs marked `fail`, `marginal` or `unverified` by the route check.
- The panel offers both as check boxes.
- Harbour stage: an end in a harbour narrower than the corridor is planned out to open water at
  a 10 m corridor, each part proved at its own corridor; a point alongside a quay leaves by a
  berth leg, marked in the reply and the panel.
- Less work per plan (field trials: Turku 18.4 M → 4.8 M work units, Miami Beach Marina 39 M →
  1.5 M): ends and harbour handovers join the nearest squares best first, A\* classifies a square
  only when it reaches it and weights its heuristic by 1.25, the strict search crosses marginal
  water at a cost, and an end the search cannot join goes to its harbour stage before any
  whole-route fallback.
- Tide gates: with `latestDeparture`, a route that passes only at some states of the tide is
  offered leaving at the earliest departure up to then that the route check passes, with the
  wait; the planner asks the planning API about each gated leg over 15-minute windows.
- Waiting en route: with `waitEnRoute` too, when no single departure passes, the plan waits for
  the water on the way, at places along the route the planning API passes with room to swing at
  anchor at the trip's lowest water, at most as long in all as the boat may wait to leave. The
  route is split where it waits, each piece proved from when the boat leaves for it, and the
  reply lists the waits (`gate.waits`); the panel offers it as a check box.
- Waiting places: a wait is at the user's `waitPoints` or a charted anchorage (`ACHARE`, not one
  where anchoring is prohibited or restricted) when one serves, on the route or within
  `waitReach` (1 nm) of it by a detour out and back the planning API passes at the trip's lowest
  water; else at the route's own places. Each wait names its `place`.
- Risk: every offered route states its `risk`, 1 − Π(1 − P) over its legs. `riskWeight` adds a
  cost per metre of α · P / threshold, so the route keeps away from the margin, and `riskBudget`
  refuses a route whose risk is over it. `alternatives: true` plans the shortest, balanced and
  safest routes, each proved, and offers the first within the budget with the others listed.
- Air height: `airHeight` keeps the route off bridges and overhead cables the mast does not
  clear at high water, as signalk-underkeel 0.8.0 checks them, and it keeps out of entry-prohibited
  areas and traffic lanes sailed the wrong way. An older signalk-underkeel is refused an air
  height.
- Preference lines, with `preferLines`: leading lines, recommended tracks, fairway navigation
  lines laid out for the boat's draft and the boat's own tracks that signalk-underkeel lists are
  kept to where that costs little more distance, to starboard of a two-way line (COLREG rule 9).
- Panel: start from the boat's position; the shortest, balanced and safest routes drawn on the
  map and listed, any of them written with **Use**; each leg's flags in words; a dragged waypoint's
  legs planned again; keeping to fairway lines and own tracks as a check box. The manifest offers
  `routePlan` in the `navigationSafety` services, and `npm run trial:panel` runs the panel in
  Chromium on the field trials' charts.
- Planning past the chart box: when signalk-underkeel serves `prepare`, `/plan` asks it for an
  index of the whole search region, or of the trip's least region (both ends with the search's
  least margin and a harbour stage around them) when that is too large to build: the chart box
  around the vessel when it covers the region, else a planning box underkeel builds. While the
  build runs past a short wait, `/plan` answers 503 with `preparing: true` and `Retry-After`.
  The panel plans again while the build continues, then asks to plan again later if it is still
  unfinished, and does not write a plan over a route edited while it waited.
- Corridors for trips too long for any planning box: with signalk-underkeel's `survey` and
  `corridor`, a coarse route on its depth survey of the trip's region, a band along it built as
  the planning box. A corridor's trip may be up to 100 nm, its search given work in proportion to
  its length; the search asks about no square that reaches past the corridor's boxes and searches
  the square around them. `npm run trial:r2` plans Turku to Utö, 50 nm, within a 2 GB memory
  limit, and `--profile` shows where its work goes.
- Work budget: the plugin's **Work budget per plan** setting is the work a plan may do at least,
  and a longer trip in the chart box is given more in proportion to its distance, as a
  corridor's is. The plugin times the plans it runs and says in its status and `GET /status`
  what the budget takes on this machine; that only reports, and no plan depends on it.
- Attributions: an offered route lists the open data it leaned on (`attributions`), the FTIA's
  navigation lines it kept to and Traficom's WFS depths it crossed, and the panel shows the
  credit under the plan.
- Field trials, `npm run trial`: Turku to Nauvo on the Traficom WFS and Miami from sea on NOAA
  ENC cells, each checked against its recorded expectation.
