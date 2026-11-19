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
- Planning past the chart box: when signalk-underkeel serves `prepare`, `/plan` asks it for an
  index of the whole search region, or of the trip's least region (both ends with 3.5 km around
  them) when that is too large to build: the chart box around the vessel when it covers the
  region, else a planning box underkeel builds. While the build runs past
  20 s, `/plan` answers 503 with `preparing: true` and `Retry-After`. The panel plans again while
  the build continues, then asks to plan again later if it is still unfinished, and does not
  write a plan over a route edited while it waited.
- Field trials, `npm run trial`: Turku to Nauvo on the Traficom WFS and Miami from sea on NOAA
  ENC cells, each checked against its recorded expectation.
