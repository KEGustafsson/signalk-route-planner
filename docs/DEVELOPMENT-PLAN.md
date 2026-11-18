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
Freeboard extension (public/) ── POST /plugins/signalk-route-planner/plan ──► planner plugin
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

```ts
interface PlanningApiV1 {
  readonly version: 1;
  /** Why planning cannot run now; undefined when the index is ready. */
  unavailable(): string | undefined;
  /** The box the index covers [west, south, east, north]; undefined for a whole index. */
  coverage(): [number, number, number, number] | undefined;
  defaults(): { speed: number; xteLimit: number; probability: number; planningBuffer: number };
  /** Runs `job` with the index, in underkeel's request queue. */
  session<T>(
    params: SessionParams,
    signal: AbortSignal,
    job: (s: Session) => Promise<T>
  ): Promise<T>;
  /** The `/route-check` service: same body, same reply. */
  routeCheck(body: unknown, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
}

interface SessionParams {
  departure: number; // epoch ms
  until: number; // end of the time window the verdicts hold for, epoch ms
  speed: number; // m/s
  xteLimit?: number;
  probability?: number;
  draft?: number;
}

interface Session {
  /** Corridor half-width: xteLimit + planning buffer, metres. */
  readonly halfWidth: number;
  /** Every point of the box with halfWidth around it, at the lowest level in the window.
   *  Throws RangeError when the box with that buffer is over 25 km². */
  box(sw: [number, number], ne: [number, number], window?: { start: number; end: number }): Verdict;
  /** The leg a → b, checked as /route-check checks a leg, over the window. Throws
   *  RangeError when its corridor (length plus both ends, times 2 · halfWidth) is over 25 km². */
  segment(
    a: [number, number],
    b: [number, number],
    window?: { start: number; end: number }
  ): Verdict;
  /** Work done so far, in underkeel's work units (src/engine/work.ts). */
  work(): number;
  /** Yields to the event loop; rejects once the request is aborted. */
  pause(): Promise<void>;
}

interface Verdict {
  status: "ok" | "marginal" | "fail" | "unverified";
  risk: number;
  flags: string[];
  worst?: [number, number];
}
```

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
4. **String pulling.** From each kept waypoint, the farthest later path point whose straight leg
   `session.segment` passes becomes the next waypoint. Every leg of the result has passed the
   corridor check over the trip window.
5. **Proof.** `routeCheck` checks the route at its departure, leg by leg at each leg's own arrival.
   Its statuses are the answer.
6. **Why not straight.** The direct line's check result is returned when it fails, naming the
   worst hazard: the binding constraint.
7. **Bounded work.** The plan counts underkeel work units and stops at a limit sized for about
   3 s on a Raspberry Pi 4, refusing with the reason rather than returning a partial route.

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

`POST /plugins/signalk-route-planner/plan`

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
  "legs": [/* underkeel route-check legs */],
  "status": "ok", // worst leg status
  "direct": { "status": "fail", "worst": [22.21, 60.24] }, // the straight line's check
  "work": 182340
}
```

Reply 422 when no route exists, with `reason` and, when only unverified water connects the
points, `unverifiedOnly: true`. Reply 503 when the planning API is missing or the index is not
ready.

## 6. Performance budget

Raspberry Pi 4 is the reference. One plan may do 1 200 000 underkeel work units (about 3 s on a
Pi 4 at underkeel's calibration, 0.4 s on an i5 laptop). The search stops at 80 % of that and the
proof gets the rest. Work is counted, never timed, so a request gives the same answer on any
machine.

## 7. Testing

- Unit tests run the search against a synthetic oracle: polygon obstacles and unverified areas in
  a local metric plane, with exact segment and box predicates.
- Properties (fast-check): every returned leg clears every obstacle by the half-width; a request
  with a deeper draft (a larger obstacle set) never returns a route the shallower one rejected;
  no route crosses an unverified area while reported `ok`.
- A contract test in `signalk-underkeel` checks the API it registers against `PlanningApiV1`.
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
