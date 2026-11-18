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
- `fallback: true`: when no route passes, the least risky route through charted water, never over
  land, with its risky legs marked `fail`, `marginal` or `unverified` by the route check.
- The panel offers both as check boxes.
- Harbour stage: an end in a harbour narrower than the corridor is planned out to open water at
  a 10 m corridor, each part proved at its own corridor; a point alongside a quay leaves by a
  berth leg, marked in the reply and the panel.
- Field trials, `npm run trial`: Turku to Nauvo on the Traficom WFS and Miami from sea on NOAA
  ENC cells, each checked against its recorded expectation.
