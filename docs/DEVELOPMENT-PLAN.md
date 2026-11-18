# Safe-water route planner: development plan

`signalk-route-planner` is a Signal K server plugin and a Freeboard-SK extension. Given a start
and a destination, it finds the shortest route through water deep enough for the boat, at the
time the boat will be there, and hands it to Freeboard as an unsaved draft. Every leg it offers
has passed the same corridor route check that `signalk-underkeel` runs for `/route-check`.

The plugin is advisory. It never sends autopilot or steering commands, and a route is a
suggestion the skipper edits, saves and activates.

## 1. What exists, and what this adds

Checked on 2026-11-18 against product documentation and the npm registry:

| Product                                     | Depth input                                         | Tide height                             | Survey quality          | Unknown water                     |
| ------------------------------------------- | --------------------------------------------------- | --------------------------------------- | ----------------------- | --------------------------------- |
| Garmin Auto Guidance / Auto Guidance+       | safe depth, safe height, shoreline distance         | not documented                          | no                      | section skipped                   |
| Navionics Dock-to-dock                      | safe depth plus a hidden margin                     | lowest tide (LAT)                       | no                      | not documented                    |
| C-MAP Easy Routing (Raymarine, B&G, Furuno) | safe depth, width, height                           | "assumes some tide"; user adds margin   | no                      | some dredged-area hazards ignored |
| Orca                                        | depth, height, shore leeway                         | not documented                          | no                      | routed through, drawn red         |
| Aqua Map                                    | draft, clearance, USACE survey age                  | chart datum                             | survey age only (USACE) | not documented                    |
| signalk-routeiq 0.1.0                       | draft, air draft, beam margins on a pre-built graph | at time of passage; 24 h departure scan | shown, never routed on  | Netherlands graph only            |
| signalk-weather-router-plus 0.2.1           | charted depth vs draught + fixed 0.5 m              | no (MSL layer "not for UKC")            | no                      | not documented                    |
| OpenCPN                                     | no depth-aware auto-router                          |                                         |                         |                                   |

No product found routes on survey quality, bounds the probability of grounding, waits mid-route
for the tide, or explains why each leg is safe. This plan does all four:

1. **Chance-constrained cost.** A leg is accepted only when its P(UKC < 0), from
   `signalk-underkeel`'s CATZOC/QUAPOS uncertainty, water level σ, squat and wave allowance, is
   below the threshold; the route also has a total risk budget.
2. **Time-dependent search with tide gates.** The search state is (position, time). Where the
   forecast says the water will rise, the plan may wait at a permitted waiting place and go on.
3. **Keel and mast together.** Air draft against charted vertical clearance (`VERCLR`,
   `VERCCL`, `VERCOP`) moves the other way with the water level, so a passage can open only
   between two limits.
4. **Plan, then prove.** The search proposes; `signalk-underkeel`'s unchanged route check
   decides each leg's status. Water the check cannot verify is reported `unverified`, with the
   reason, and is never offered as `ok`.
5. **Explanations and counterfactuals.** Each leg carries the route check's explanation, and the
   route names its binding constraint ("the direct line crosses a 1.6 m rock, CATZOC C, at
   14:30 at −0.21 m") and what would change it ("leaving at 16:10 saves 4.1 nm").
6. **Alternatives.** Shortest, safest and balanced routes, each with its length and risk.
7. **Seamanship rules as constraints.** Entry-prohibited restricted areas, traffic separation
   lane direction, the starboard side of narrow fairways, leading lines and fewer turns.
8. **No pre-built graph.** The search graph is built on demand from the min-depth pyramid, so it
   works on any S-57 ENC the charts provider serves.

## 2. Architecture

```text
Freeboard-SK ──(Plotter Extensions bus: route.create / replace / save, overlays, panel)──┐
                                                                                          │
Freeboard extension (public/) ─ POST /plugins/signalk-route-planner/v1/plan ─► planner plugin
                                                                                 │
                                         in-process planning API v1 (globalThis) │
                                                                                 ▼
                                   signalk-underkeel: chart index, water level, vessel,
                                   corridor check (same code as /route-check)
```

- **The planner never builds its own chart index.** One index per server keeps the memory
  budget of a Raspberry Pi or Cerbo GX. `signalk-underkeel` (0.7.0 and later) registers a
  versioned object under `globalThis[Symbol.for("signalk-underkeel.planning")]` when it starts
  and removes it when it stops. Both plugins run in the Signal K server's Node process.
- **A session's parameters** are held to `/route-check`'s bounds (speed, cross-track limit,
  probability, draft); an out-of-range value answers 400 before the search starts.
- **When the API is missing** (underkeel not installed, stopped, or older), `/plan` answers 503
  with the reason, and the plugin status says so (never silent).
- **Planning runs inside underkeel's request queue** (`session`), one request at a time with the
  route check, repair, departure window and query, yielding between steps so look-ahead ticks
  keep running.
- **Freeboard core (later, R5):** `routePlan` joins the provider-neutral `navigationSafety`
  services contract, so Freeboard can offer "Route here through safe water" in its own context
  menu from any provider.

### 2.1 Planning API v1 (`signalk-underkeel`)

The types are in `src/oracle/contract.ts`, a copy of underkeel's `src/planning-api.ts`. What
the planner relies on:

- `unavailable()` says why planning cannot run now; `defaults()` gives the route check's speed,
  cross-track limit, probability and planning buffer.
- `session(params, signal, job)` runs `job` in underkeel's request queue with a `Session` over a
  time window: `box(sw, ne)` checks every point of the box with the corridor half-width around
  it, `segment(a, b)` checks a leg as `/route-check` does, both at the window's lowest water
  level. A box or leg corridor over 25 km² throws `RangeError`; the planner never sends one.
- `work()` counts underkeel's work units and `pause()` yields, rejecting once the request is
  aborted.
- `routeCheck(body, signal)` is the `/route-check` service itself, so the proof's statuses are
  underkeel's.
- Every verdict carries its status (`ok`, `marginal`, `fail`, `unverified`), P(UKC < 0), flags
  and the worst point: the planner never makes a status up.

## 3. Safety invariants

The seven invariants of `signalk-underkeel` (its AGENTS.md) hold here. In addition:

1. **Every offered leg is verified.** A route's leg statuses are the ones underkeel's route check
   returns for the final route at its departure; the planner never sets a status itself.
2. **Unverified is never safe.** A path through `NO_COVERAGE`, `UNASSESSED`, `NO_DEPTH` or a
   fallback water level is reported `unverified` with the reason, and is never ranked as `ok`.
3. **Monotonic.** A deeper draft, a taller air draft, a lower water level or a smaller accepted
   probability never yields a route that a less constrained request rejected. Covered by a
   fast-check property over the synthetic oracle.
4. **Hard rules stay hard.** Entry-prohibited restricted areas and traffic separation lane
   direction are never traded for distance.
5. **Own data only adds caution.** Tracks the boat has sailed may lower cost, never risk, and only
   at a water level no lower than when they were sailed.
6. **No actuation.** The plugin writes routes as unsaved drafts; it never activates a route or
   sends steering commands.

## 4. Algorithms

### 4.1 R1: static search

1. **Region.** The box around start and destination, widened by half their distance and at
   least 2 km, clipped to `coverage()`. A destination outside it answers with the reason.
2. **Quadtree from the oracle.** The region is a square in a local east/north frame. A square is
   classified with `session.box` over the whole trip window:
   - `ok`: a free leaf; any leg inside it passes.
   - `fail` at the smallest size: blocked.
   - `unverified` at the smallest size: blocked, and counted, so a failed plan can say the only
     way through is unverified water.
   - otherwise it splits into four, down to a cell of max(10 m, halfWidth / 2).
     Squares are classified lazily as A* reaches them, so open water stays a few large leaves.
3. **A\*** over free leaves that share an edge, through the midpoint of the shared edge, with the
   straight-line distance as the heuristic.
4. **String pulling.** From each kept waypoint, later path points are tried farthest first, then
   halving the distance in points, and the first whose straight leg `session.segment` passes
   becomes the next waypoint. This bounded heuristic costs O(log n) checks a waypoint and can
   miss a longer shortcut that passes after a shorter one failed. Every leg of the result has
   passed the corridor check over the trip window.
5. **Proof.** `routeCheck` checks the route at its departure, leg by leg at each leg's own arrival.
   Its statuses are the answer. A plan without `fallback` is offered only when every leg is `ok`,
   `marginal` or an accepted `unverified`; otherwise the reply is 422 with the route check.
6. **Why not straight.** The direct line's check result is returned when it fails, naming the
   worst hazard: the binding constraint.
7. **Data not for navigation.** With `accept: ["NOT_FOR_NAVIGATION"]` the search may plan through
   water whose only check flag is that the source is not for navigation (Traficom WFS depth data)
   and whose P(UKC < 0) is below the threshold. The route check still marks those legs
   `unverified`.
8. **Fallback.** With `fallback: true`, when no route passes, the search runs again over the same
   squares and may cross charted water the check fails or cannot verify, at a cost per metre
   that grows with P(UKC < 0), with a further penalty when unverified, so the route trades
   distance for risk (`RISK_WEIGHT` and `UNVERIFIED_WEIGHT` in `src/search/fallback.ts`). It
   crosses only verdicts whose flags say how the depth was charted; land, water with no chart,
   squares never queried and any other flag, such as a hard rule's, stay closed. String
   pulling straightens such a stretch only within itself. The reply carries `fallback` with the
   reason no route passed, and the risky legs come back `fail`, `marginal` or `unverified` from
   the route check, marked.
9. **Diagonal channels.** Squares that meet only at a corner are joined through that corner: a
   path through it lies in the two squares, so its corridor stays in their checked footprints.
10. **Bounded work.** The search and string pulling count underkeel work units and stop at a
    limit sized for about 3 s on a Raspberry Pi 4, refusing with the reason rather than returning
    a partial route.
11. **Boxes the API takes.** A box's longitude span widens away from the frame's origin latitude,
    so each box is measured at its own latitude and split while it, with its buffer, is over
    the API's box limit (`MAX_BOX_KM2` in `src/search/quadtree.ts`), so no query is refused. A
    region across the 180° meridian or over a pole is refused.
12. **Harbour stage.** A guest harbour, a river berth or a marina is often narrower than the
    request's corridor, so the search cannot join that end. It then names the free water within
    `harbourMetres` (3 km) of the end, and a harbour stage plans the end out to it at
    `harbourXte` (0 m: the planning API's 10 m buffer alone), in a session of its own. Handovers
    not much farther than the nearest (1.5×, or 300 m more) are tried most-on-the-way first, so
    the route does not double back from the nearest free water. The main search then runs
    between the handover points. Each part is proved by its own route check at its own corridor,
    from the time the boat reaches it, and every leg names its part and corridor.
13. **Berth legs.** Alongside a quay, even the harbour corridor touches the quay. The harbour
    stage then joins the end by the shortest stub, at most `berthMetres` (40 m), beyond which a
    checked leg joins, found by bisection. The berth leg is returned as its own leg with the
    route check's status (usually `fail`, `LAND`) and `berth: true`; the reply's `underway`
    status covers every other leg, and `status` stays the worst of all. A strict plan is not
    refused for its berth legs. The planner cannot check a berth leg, so the panel says to steer
    it by eye.

### 4.2 R2: planning beyond the chart box

`signalk-underkeel` indexes a box around the vessel (default 10 km). R2 adds a planning box to
underkeel: an index built on request for the corridor between start and destination, in its build
worker at low priority, from the same cell cache, released after use. API v1 gains
`prepare(region, signal)`; the version stays 1 and the capability is listed in `features`.

### 4.3 R3: time-dependent search and tide gates

- State (leaf, arrival slot); slots are 15 minutes, the water level forecast's step.
- An edge is open when `session.segment` passes over the slot's window.
- **Waiting** is allowed only at permitted places: charted anchorage areas (`ACHARE`), user
  waiting points, and optionally deep water off the fairway with room to swing. A wait is an edge
  to the next slot at the same place.
- Waiting is a FIFO edge (arriving later never lets you leave earlier), so time-dependent
  Dijkstra with earliest arrival is exact over the slots.
- The answer is a timed plan: "leave 14:20, wait 40 min at the anchorage off X, cross at 16:05".

### 4.4 R4: risk, alternatives, air draft, rules

- **Cost** = distance × (1 + α · P / threshold), so routes keep away from the margin; swept
  areas (`SWPARE`) carry little σ and are preferred on that alone.
- **Risk budget:** the product of each leg's (1 − P) stays above 1 − budget.
- **Alternatives:** shortest (α = 0), safest (large α plus a fairway preference) and balanced,
  each re-proved.
- **Air draft** from `design.airHeight`, or the plugin setting: blocked under a bridge or an
  overhead cable or pipe whose clearance minus the water level rise above its datum is below air
  draft plus margin. API v1 gains `features(bbox)` for the S-57 objects below.
- **Rules:** `RESARE` with entry prohibited is blocked; `TSSLPT` lanes are crossed only near 90°
  and followed only in their `ORIENT` direction; narrow `FAIRWY` paths are offset to the
  starboard side (COLREG rule 9); `NAVLNE` and `RECTRC` leading lines get a cost discount; turns
  get a small cost per turn.
- **Finnish fairway data:** Finnish Transport Infrastructure Agency open data (fairway areas and
  navigation lines, CC BY 4.0) as preference lines, read through underkeel's WFS client.
- **Own tracks:** passages the boat has logged (underkeel's living chart) get a cost discount at
  a water level no lower than when they were sailed.

### 4.5 R5: Freeboard UX and upstream

- Extension panel: start at the vessel or at the first point of a selected two-point route,
  destination at its last point; alternatives drawn as overlays; the chosen one written with
  `route.replace` as an unsaved draft; the timed plan and each leg's explanation in the panel.
- Interactive editing: a dragged waypoint re-plans the two legs beside it.
- `routePlan` in the `navigationSafety` services contract (Freeboard core).

## 5. REST API

`POST /plugins/signalk-route-planner/v1/plan`

```jsonc
{
  "from": [22.1, 60.2],
  "to": [22.31, 60.27],
  "departure": "2026-11-18T07:00:00Z", // optional; default now
  "speed": 3.1, // m/s; default underkeel's route-check speed
  "xteLimit": 30, // optional
  "probability": 0.01, // optional
  "draft": 1.9 // optional override
}
```

Reply 200:

```jsonc
{
  "plannedAt": "…",
  "route": {
    "type": "LineString",
    "coordinates": [
      [22.1, 60.2],
      [22.18, 60.23],
      [22.31, 60.27]
    ]
  },
  "length": 14250, // metres
  "status": "ok", // worst leg status
  // Underkeel's route-check legs, numbered through, each with its `part` ("harbour" or
  // "route"), `xteLimit` and, for a berth leg, `berth: true`; `parts` spans them.
  "check": {
    "legs": [/* … */],
    "parts": [{ "part": "harbour", "end": "start", "xteLimit": 0, "legs": [0, 4] }]
  },
  "underway": "ok", // with berth legs: the worst status of the other legs
  "berths": [{ "end": "start", "leg": 0, "length": 12 }],
  "direct": { "status": "fail", "worst": [22.21, 60.24] }, // the straight line's check
  "work": 182340
}
```

Reply 422 when no route exists, with `reason` and, when the search met water the check cannot
verify, `unverifiedSquares`: how many one-unit squares it was. Reply 503 when the planning API
is missing or the index is not ready.

## 6. Performance budget

Raspberry Pi 4 is the reference. One plan may do 1 200 000 underkeel work units (about 3 s on a
Pi 4 at underkeel's calibration, 0.4 s on an i5 laptop). A\* stops at 80 % of that and string
pulling at the whole. A plan's stages (the main search, harbour stages, the main search again)
draw on that one budget, each with what the stages before it left. The proof is underkeel's
route check, bounded by `/route-check`'s own limits; its work is not counted in the plan's. Work
is counted, never timed, so a request gives the same answer on any machine.

## 7. Testing

- Unit tests run the search against a synthetic oracle: polygon obstacles and unverified areas in
  a local metric plane, with exact segment and box predicates.
- Properties (fast-check): every returned leg clears every obstacle by the half-width; a request
  with a deeper draft (a larger obstacle set) never returns a route the shallower one rejected;
  no route crosses an unverified area while reported `ok`.
- A contract test in `signalk-underkeel` checks the API it registers against `PlanningApiV1`.
- **Field trials** (`docs/trials.md`): `npm run trial` plans the cases in
  `scripts/trials/trials.json` on real chart data, Turku to Nauvo on the Traficom WFS and
  Miami from sea on NOAA ENC cells, and checks each against its recorded expectation. They need
  network and a built signalk-underkeel, so they are not part of `npm test`; run them for every
  search or plan change.
- **Test runtime.** `npm test` stays hermetic and under 120 s, as in underkeel: tests run in
  `__tests__/helpers/node-realm-environment.js`, a test makes at most 5 000 `expect()` calls
  (`__tests__/helpers/assertion-budget.ts`), and CI fails the run past 120 s
  (`PLANNER_TEST_BUDGET_S`, `__tests__/helpers/budget-reporter.js`).

## 8. Milestones

| R   | Scope                                                                                    | Exit criteria                                                                            |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| R1  | Planning API v1 in underkeel; quadtree A*, string pulling, proof; `/plan`; minimal panel | every returned route's legs come from underkeel's route check; properties green          |
| R2  | Planning box beyond the chart box                                                        | 50 nm plan within the memory budget on a Pi 3 / Cerbo GX                                 |
| R3  | Time slots, waiting places, timed plan                                                   | Wadden Sea fixture: a plan that waits for the tide where every fixed departure fails     |
| R4  | Risk cost and budget, alternatives, air draft, S-57 rules, FTIA lines, own tracks        | each alternative states length and risk; bridge fixture blocks a tall mast at high water |
| R5  | Freeboard panel, interactive re-plan, `routePlan` service contract                       | live Freeboard trial                                                                     |

## 9. Open questions

- The Pi 4 work-unit calibration is underkeel's laptop measurement times 3–5 (its plan §10);
  the planner inherits that until measured on a Pi.
- FTIA open data licence attribution must show in the panel; confirm the exact wording.
- Whether waiting in deep water off the fairway needs a minimum distance from the fairway edge
  beyond the swing radius.
