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
- Narrows: the main search runs at the harbour corridor, and water narrower than the request's
  corridor costs twice as much per metre unless it lies on a charted fairway line, so a route
  takes a sound or a fairway where the way round costs more and keeps the request's corridor
  elsewhere. Legs the request's corridor does not pass are `narrows` parts proved at the harbour
  corridor and named in the panel (`narrows: false` and a panel check box turn it off). Nauvo to
  Kaldö through Killingholms sund at xte 30 m: 3.1 nm, where the plan was refused at the work
  limit; Turku to Nauvo through the Seili fairway, 17.8 nm.
- Fairway stage: the narrow search also follows the charted navigation lines, as a graph checked
  leg by leg, through a swept fairway narrower than its squares. Fallböle to Sattmarkssundet:
  1.5 nm along the fairway, where no route passed. Flags that describe the water (`DREDGED`,
  `FAIRWAY_GAP`, …) no longer keep an accepted `unverified` leg out.
- Corners of long legs are cut: the fairway stage's chain of lines and a route's straightened
  parts no longer keep the L where two lines meet (Pargas to Nagu 13.25 nm, where it was 13.96).
- The fairway stage runs before the search, and the search looks only for a way shorter than
  the lines' (with preference lines, within 10 %): far less work where the lines' way is near
  the shortest (Pargas to Nagu 1.5 M against 10 M, Turku to Nauvo 4.3 M against 11.9 M). An end
  is joined to the lines within 2 km, so a fallback from a harbour stage keeps its lines' way.
- Band refinement: each part of a shortest route is searched again on a 100 m grid in a band 1 km
  either side of it, at the part's own corridor, every leg checked, so a route the search led
  round the long side of an islet takes the short side; then a 30 m grid round each turn, where
  the route touches land, takes gaps narrower than the first grid. Pargas to Nagu 12.85 nm, south
  of Torrgrund, where it was 13.09 north of it.
- No pilotage: the planner asks signalk-underkeel for none, so no GNSS reading, live or past,
  reaches a plan; underkeel's corridor is the cross-track limit and half the beam. A leg held to a
  fairway's line under a bridge is flagged `FAIRWAY_GAP`, and the panel names it "under a bridge,
  on the fairway line".
- A plan whose planning box signalk-underkeel released before its session ran is prepared and
  planned again, once, rather than answering 503.
- The raster field: with a signalk-underkeel serving `raster` (0.8.0), a leg or square is settled
  on the chart's own tiles where they say whether the rule passes it, and asked of the route
  check only where they do not; the route check still proves every leg of the route offered.
  Parainen to Nauvo guest harbour: the same 24 338 m route for 0.81 M work units where it took
  5.23 M, 1 072 legs asked of the chart where it asked 15 246; in the running server on a Jetson
  Orin 3.4 to 3.8 s where it took 34.8 s.
- A trip's index is asked for its snug region first, the ends and a quarter of the trip's length
  around them on a grid, a third to a half of the search region: built in that share of the
  time. A route no way leaving the region could be cheaper than stands (its price its length and
  the narrows weight on its narrows legs); any other, a route priced by more than that (a risk
  weight, preference lines, alternatives, a fallback) and a
  refusal for want of a way are planned again in the whole search region. When the machine
  refuses the larger region's build (413), the smaller region's answer is kept, so that route
  had no search past the smaller region. Before any build, an
  index signalk-underkeel holds already that covers the trip's ends is planned on (its `held`).
- The plugin's debug log says when a plan is planned again in a larger region, and what the
  plan in the smaller one came to.
- The joint between a harbour stage and the route is eased: the route no longer turns at the
  handover point whichever way the two parts came (out of Parainen's marina, 180 m toward the
  bridge and back). The harbour part is drawn tight with the route's first 500 m past the
  handover, at the harbour corridor, and takes that stretch over. Parainen's marina to Pargas
  Port 15 872 m where it was 16 094 m.
- While an index builds, `/plan`'s 503 asks the panel back in 3 s, not 30: the request asked
  again waits for the build itself, so the plan follows the build by seconds.
- The fairway stage finds where lines meet by a grid of their legs, not every point against every
  leg (1.4 s of a 13.9 s plan with 919 lines in the region), and band refinement's search keeps
  its points by number.
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
- The route passable now: with no waiting asked for, each square and leg is asked about at the water
  of the times the boat can be there, not at the lowest water of the whole verdict window. The
  first search allows the boat any timing within the verdict window, so its route holds however
  the boat keeps to it. When it finds none and the tide could change that, it searches again at a
  reach near the straight distance, where each square's window is the boat's own timing from the
  departure, widened by `timingSlack`; a route found there holds only leaving at the departure.
  The proof then checks each leg at the time the boat reaches it. Route replies and refusals name
  the timing they hold for (`timing`); error replies carry none.
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
- Panel: start from the boat's position; each leg's flags in words; a dragged waypoint's
  legs planned again, also in Freeboard, which hands a route's points back a few 1e-14 degrees off
  through its map projection; keeping to fairway lines and own tracks as a check box. The manifest offers
  `routePlan` in the `navigationSafety` services, and `npm run trial:panel` runs the panel in
  Chromium on the field trials' charts.
- Planning past the chart box: when signalk-underkeel serves `prepare`, `/plan` asks it for an
  index of the trip's snug region, then the whole search region when the plan may be beaten
  past it (above), or of the trip's least region (both ends with the search's least margin and
  a harbour stage around them) when the region asked for is too large to build: the chart box
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
- Steering: between joined ends, a coarse pass over the same region's larger squares, sharing
  their box verdicts, finds the way that likely leads through, and the search reaches the
  squares along it first. It changes only the order of the search, never a square's verdict or
  the route check. Field trials: Turku to Nauvo 7.0 M → 5.4 M work units for one pass, the Bayside
  fallback 25.7 M → 19.7 M, kept to water the coarse pass found free. Not used with preference lines, a
  risk cost or in a corridor.
- A depth survey underkeel refuses as too large is asked for in up to eight overlapping pieces
  along the trip and joined, so a long diagonal trip still gets its corridor.
- Work budget: the plugin's **Work budget per plan** setting is the work a plan may do at least,
  and a longer trip in the chart box is given more in proportion to its distance, as a
  corridor's is. The plugin times the plans it runs and says in its status and `GET /status`
  what the budget takes on this machine; that only reports, and no plan depends on it.
- Taut routes: a planned route is drawn tight round what stops it, turning at the corners of
  islands and shoals rather than at the search's square centres, and A\* runs again at a finer
  greed to find a shorter channel its first pass took for a longer one: steered, without the
  guide that may have led it there, on at most half the work left. Turku to Utö on the
  Traficom WFS: 53.19 nm in 79 legs before, 52.53 nm in 50 after, now shorter than the route kept
  to the FTIA lines. A change never makes a leg riskier or draws in more failing water.
- Attributions: an offered route lists the open data it leaned on (`attributions`), the FTIA's
  navigation lines it kept to and Traficom's WFS depths it crossed, and the panel shows the
  credit under the plan.
- Panel: three choices, from what changes from trip to trip. Start at the boat or the route's
  first point; the shortest route or the route using fairways; the wait for the tide, which may also wait on the way. A row shows the draft signalk-underkeel plans with
  (Signal K's `design.draft` unless set there) and the route check's cross-track limit, speed and
  accepted risk, and changes them for the plan (risk low, normal or
  high: a tenth, once or five times the route check's). After a refusal a button plans the
  lowest-risk route, its risky legs marked. Sounds narrower than the corridor and the re-plan of
  a dragged waypoint are always on. Depth data marked not for navigation is the plugin setting
  **Plan on depth data marked not for navigation**. `GET /status` gives the route check's
  settings (`defaults`). The panel keeps its choices in the browser. It no longer offers the
  shortest, balanced and safest routes, nor draws them on the map: in the archipelago they were
  refused where the shortest passed, and kept close to it where offered; `alternatives` stays in
  the REST API.
- Field trials, `npm run trial`: Turku to Nauvo on the Traficom WFS and Miami from sea on NOAA
  ENC cells, each checked against its recorded expectation.

### Fixed

- A route drawn tight could keep a point twice where a turn moved onto its neighbour: a leg of
  no length in the check, one more leg than the route has.
