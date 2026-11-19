# Safe-Water Route Planner

A Signal K server plugin and Freeboard-SK extension that plans the shortest route through water
deep enough for the boat, between the start and destination of a route you draw. Every leg of a
plan is checked by [Under-Keel Awareness](https://github.com/KEGustafsson/signalk-underkeel)
(signalk-underkeel) the same way its `/route-check` checks a route: a corridor of the cross-track
limit plus a planning buffer, scored by P(UKC < 0) from the chart's survey quality, the water
level forecast, draft, squat and waves.

**Advisory only.** A plan is a suggestion written into your route as an unsaved change. Check
every leg on an official chart before you sail it. The plugin never sends autopilot or steering
commands.

## Requirements

- Signal K server 2 with Freeboard-SK and its Plotter Extensions support.
- signalk-underkeel 0.7.0 or later, installed, enabled and with its chart index built. The
  planner uses its charts, water level and vessel; it builds no chart index of its own.

Without signalk-underkeel the plugin status reads "Waiting: signalk-underkeel 0.7.0 or later is
not running" and `/plan` answers 503 with that reason.

With a signalk-underkeel that serves planning boxes (it lists `prepare` in its planning API's
`features`), a trip past its chart box around the vessel is planned on a planning box it builds
for the trip's region, from the same charts, behind the chart box. The first plan of a new region
waits for that build, which can take minutes on a Raspberry Pi: the panel says so and plans again
by itself while the build runs. Without `prepare` the planner plans on the chart box alone, and
legs past it come back `unverified`.

A trip too long for any planning box the machine builds is planned in a corridor, when
signalk-underkeel 0.8.0 or later also serves `survey` and `corridor` (with its Traficom WFS depth
source). The planner finds a coarse route on underkeel's depth survey of the trip's region, and
underkeel builds a planning box of a band a few kilometres wide along it. Past the band the chart
reads no coverage. The survey and the band are downloaded first, which takes minutes.

## Use

1. In Freeboard, draw a route from where you are to where you want to go. Two points are enough.
2. Open **Route planner** from the map toolbar, pick the route and press **Plan through safe
   water**.
3. The route's points are replaced by the plan as an unsaved change, with each leg's status and
   P(UKC < 0) in the panel. The route's first and last points keep their names. Save the route,
   or undo the change, in Freeboard's route editor.

When no route passes the check, the panel says why: land or shoals close every way, the only way
through is water the check cannot verify (no chart coverage or an unassessed survey), the start
or destination is not in water the check passes, or the search reached its work limit.

## How a plan is made

1. The straight line between start and destination is checked first; when it passes, it is the
   plan.
2. Otherwise the region around the two points is divided into squares, coarse in open water and
   finer near land and shoals. A square is free water when every point in it, with the corridor
   around it, passes the check over the whole trip's time window.
3. A\* finds the shortest path through free squares, and string pulling straightens it into as
   few legs as pass the check.
4. signalk-underkeel's route check checks the final route at its departure, each leg at its own
   arrival time. The statuses you see are that check's.

`docs/DEVELOPMENT-PLAN.md` describes the design and the milestones that follow: planning past
the chart box, waiting for the tide, risk-weighted alternatives, air draft under bridges and
seamanship rules.

## REST API

Base `/plugins/signalk-route-planner/v1`, open to logged-in readonly users.

| Route         | Answer                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------- |
| `GET /status` | `{ state: "ready", provider }` or `{ state: "off", reason }`                                  |
| `POST /plan`  | 200 with the planned `route`, its `length`, `status` and the route check; 422 with a `reason` |

A `/plan` body carries `from` and `to` as `[lon, lat]`, and optionally `departure` (ISO 8601),
`speed` (m/s), `xteLimit` (m), `probability` and `draft` (m); unset options take
signalk-underkeel's route-check settings. `accept: ["NOT_FOR_NAVIGATION"]` plans on depth data
marked not for navigation (its legs stay `unverified`), and `fallback: true` returns, when no
route passes, the lowest risk-weighted route through charted water with its risky legs marked. Start and destination may be at most 60 km apart.

While signalk-underkeel builds the chart index for a trip's region, `/plan` answers 503 with
`preparing: true` and a `Retry-After` header; ask again then. A region too large to build on the
machine is 413 with underkeel's reason.

An end in a harbour narrower than the corridor (a guest harbour in a river, a marina) is planned
out to open water in a harbour stage at a 10 m corridor, and a point alongside a quay leaves by a
short berth leg the reply marks (`berths`, and `underway` for the status of every other leg).

With `latestDeparture` (ISO 8601, at most 24 h after the departure), a route that passes only at
some states of the tide is offered leaving at the earliest departure up to then at which the
route check passes every leg as the boat reaches it (`departure`, `gate`). The panel offers it as
"wait for the tide, at most".

## Documentation map

| Document                    | Contents                                          |
| --------------------------- | ------------------------------------------------- |
| `docs/DEVELOPMENT-PLAN.md`  | design, safety invariants, algorithms, milestones |
| `docs/release-checklist.md` | the checks to run before a release                |
| `docs/trials.md`            | field trials on Turku and Miami chart data        |
| `AGENTS.md`                 | how to work in this repository                    |

## Licence

EUPL-1.2, as signalk-underkeel.
