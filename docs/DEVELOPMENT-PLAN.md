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
- With `features` listing `"prepare"`, `prepare(region, signal)` answers with a `session` and
  `routeCheck` over an index whose queries are judged on the charts wherever their corridor lies in
  `region` (§4.2). A provider without it is planned on as before.

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
   - `marginal` at the smallest size: passable at a cost per metre of 1 + 1000·P, as a strict
     plan accepts a marginal leg; the search crosses as little of it as it can.
   - otherwise it splits into four, down to a cell of max(10 m, halfWidth / 2).
     Squares are classified lazily as A* reaches them, so open water stays a few large leaves.
3. **A\*** over free leaves that share an edge, through the midpoint of the shared edge, with the
   straight-line distance as the heuristic, weighted 1.25 (`greed`): the path costs at most 1.25
   times the cheapest before string pulling, for far fewer squares classified among islands.
   A neighbour is queued unclassified at the cost it would have in free water and classified
   only when it comes off the queue, so squares A\* never reaches are never asked about.
4. **String pulling.** From each kept waypoint, later path points are tried farthest first, then
   halving the distance in points, and the first whose straight leg `session.segment` passes
   becomes the next waypoint. This bounded heuristic costs O(log n) checks a waypoint and can
   miss a longer shortcut that passes after a shorter one failed. Every leg of the result has
   passed the corridor check over the trip window.
5. **Proof.** `routeCheck` checks the route at its departure, leg by leg at each leg's own arrival.
   Its statuses are the answer. A plan without `fallback` is offered only when every leg but a
   berth leg (step 13) is `ok`, `marginal` or an accepted `unverified`; otherwise the reply is
   422 with the route check.
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
    request's corridor, so the search cannot join that end. It then names the free water near the
    end (`harbourMetres`), and a harbour stage plans the end out to it at the narrow harbour
    corridor (`harbourXte`), in a session of its own. Handovers about as near as the nearest are
    tried most-on-the-way first, so the route does not double back from the nearest free water
    (`src/plan/handover.ts`). The main search then runs between the handover points, and every
    stage draws on the plan's one work budget. Each part is proved by its own route check at its
    own corridor, from the time the boat reaches it, and every leg names its part and corridor.
13. **Berth legs.** Alongside a quay, even the harbour corridor touches the quay. The harbour
    stage then joins the end by a stub of at most `berthMetres`, toward the first free square
    near the end that a checked leg joins from the stub's far end; five halvings shorten the stub
    to within 1/32 of its first length of the shortest that joins. The berth leg is returned as its own leg with the route check's status (usually
    `fail`, `LAND`) and `berth: true`; the reply's `underway` status covers every other leg, and
    `status` stays the worst of all. A strict plan is not refused for the quay a berth leg
    touches, but a berth leg is never taken into water a hard rule or no chart closes. The
    planner cannot check a berth leg, so the panel says to steer it by eye. Defaults are in
    `src/plan/options.ts`.

### 4.2 R2: planning beyond the chart box

`signalk-underkeel` indexes a box around the vessel (default 10 km). R2 adds a planning box to
underkeel: an index built on request for a region, in a build process of its own at the lowest
CPU priority, from the same cell cache, always behind the chart box around the vessel, one at a
time and released once unused, on underkeel's policy (its plan §4.11). API v1 gains
`prepare(region, signal)`; the version stays 1 and `features` lists it.

**Built:**

- `/plan` asks for every place the search may ask about: the square its region is cut from
  around the midpoint (§4.1) and a harbour stage's region around each end, each with a
  corridor's reach (`searchRegion`, `src/plan/prepare.ts`). When that is too large to build on
  the machine (413), it asks for the trip's least region: both ends with the search's least
  margin and a harbour stage around them (`tripRegion`). Underkeel answers with the chart box
  when it covers the region, the whole index when there is no box, or a planning box built for
  it. The search and the proof then run on that index; past it the chart reads no coverage,
  `unverified`, never `ok` (invariant 2), so the search keeps to the water it can check.
- A build can take minutes on a Pi. `/plan` waits 20 s for it, then answers 503 with
  `preparing: true` and `Retry-After: 30` while the build runs on until the plugin stops. The
  panel plans again while the build continues, then asks to plan again later if it is still
  unfinished; it writes the plan only into a route unchanged since it was read. A trip whose
  least region lies inside a build's region waits for that build; others start their own, and
  every build is kept until it settles. A build a 413 turned to its own trip's least region is
  no longer shared past it: a trip it no longer holds asks for its own.
- A trip `plan()` refuses (over `maxDistance`, or start and destination the same point) builds
  nothing; a region larger than underkeel builds on the machine, even the least, is 413 with its
  reason. How large that is is underkeel's policy.

- A trip too long for even its least region is planned in a corridor (`src/plan/corridor.ts`,
  which holds its values), when underkeel serves `survey` and `corridor` (its plan §4.11). The
  planner asks for the depth survey of a region around the trip. On it, A\* finds the cheapest
  coarse route over cells that take the draft (the request's, else `COARSE_DRAFT`), each end
  joined to the nearest such cell. A cell whose least charted bound does not take the draft
  costs more, so the route keeps to water deep enough all over where it can: such a cell may
  hold a shoal or an island the cells blur, and on Turku to Utö a route through them missed the
  real way. The corridor is the coarse route with a band each side and more around each end for
  the harbour stage, cut into boxes, and `prepare` builds those boxes alone; while the machine
  refuses it as too large (413), narrower ones are asked for in turn. The survey is optimistic,
  so the coarse route only says where to look: the search and the route check on the corridor's
  index decide, and past the corridor the chart reads no coverage. A corridor build serves its
  own trip alone, at its own draft. A survey that fails, or joins the ends by none, leaves the
  least region's 413 as the reply.
- The search on a corridor's index knows its boxes (`Session.within`). It asks about no square
  whose box reaches past them: past them the chart reads no coverage, which no request accepts
  and the fallback never crosses, so such a square is unverified without a query and one across
  their edge is split until its parts lie inside or outside. Its region is the square around the
  corridor's boxes when that is smaller than the square around the midpoint, with a coarser
  smallest square than a short trip's: each halving of it doubles the boxes asked along a long
  trip's shores.
- A trip planned in a corridor, or past `maxDistance` where underkeel serves a survey, has a
  corridor's limits (`limitsFor`, `src/plan/options.ts`): a longer reach, and work in proportion
  to the trip's length, never less than a short trip's. Its index took minutes to build, and its
  shores are long.
- R2's exit trial (`npm run trial:r2`, `docs/trials.md`) plans Turku to Utö, 50 nm, on
  underkeel's own planning boxes, survey and build processes in a 2 GB memory limit.

**Still open:** most of a corridor's work is the search along the archipelago's shores, as in
§6; steering the search along the coarse route could cut it. A survey reaches only so far
(underkeel's cap on its area), so a long diagonal trip may be refused before its corridor.

### 4.3 R3: time-dependent search and tide gates

**R3a, the departure gate (built).** A request may give `latestDeparture`, at most 24 h after
`departure`. The planner never reads a tide table; it asks the planning API about legs over time
windows, at the lowest water in each.

1. The search runs over the whole horizon, from `departure` to `latestDeparture` plus the trip,
   so a leg it passes passes whenever the boat leaves.
2. When the plan does not pass as planned (refused, or offered only through the fallback), its
   route, or the fallback's route searched for the purpose, is the candidate.
3. A candidate leg that passes at the lowest water of the horizon is not gated. Each gated leg
   is asked about over every 15-minute window of the horizon, at its own corridor width.
4. The departure is the earliest on the 15-minute grid, up to `latestDeparture`, at which every
   gated leg lies, as the boat reaches it, in windows it may be passed in.
5. The route check proves the route leaving then, leg by leg at each arrival. The plan is offered
   only if it passes, with `departure` and `gate` (the requested and chosen departures, the wait
   and the gated legs); else the refusal carries `gate.reason`, why no departure qualified: legs
   no state of the water level passes, or gated legs whose windows each pass but at no common
   departure.

The work of step 3 draws on what the search left of `maxWork`.

**R3b, waiting en route (built along the route).** With `waitEnRoute`, when no single
departure passes, the boat may wait for the water on the way, at most `latestDeparture −
departure` in all, at the start and on the way together (`src/plan/waits.ts`).

- **Where it may wait:** at points along the candidate route, outside its berth legs, where the
  planning API finds water with room to swing at anchor `ok` (verified and passing) at the
  lowest water of the whole horizon, so any wait there is safe. Flags the request accepts for its
  legs never make a waiting place: a wait is in verified water or not at all. The spacing of the
  points tried and the room to swing are plan options (`waitSpacing`, `waitSwing` in
  `src/plan/options.ts`).
- **When:** each leg is gated as in R3a. Waiting is FIFO, so the schedule that arrives earliest
  is exact, and of those the one that waits least at sea is kept.
- **Proof:** the route is offered split where the boat waits, each piece proved by the route
  check from when the boat leaves for it, and offered only if every piece passes, with
  `gate.waits`. Timing that does not finish (its work limit, or the planning API's error)
  answers with its reason alone, never a route.

**R3c, waiting places (built).** A wait is at a designated place when one serves: one of the
request's `waitPoints` (up to 10), or a charted anchorage the session lists (feature "objects",
class `ACHARE`, unless its `RESTRN` prohibits or restricts anchoring), at the anchorage's centre
or where the route crosses it (`src/plan/wait-places.ts`).

- A designated place within `waitReach` (1852 m) of an inner point of the candidate route is
  joined to the nearest one by a detour out and back, which must pass, as the place's room to
  swing must, at the lowest water of the whole horizon. The detour counts as waiting.
- At each point two places are kept of those that pass: the one the boat would rather wait at
  (a user's point, then an anchorage on the route, then one off it, the nearer first) and the
  nearest. A designated place within a metre of a route point is waited at on the route only
  when that point has room to swing.
- The schedule is searched first over the preferred designated places, then over the nearest
  ones, and only when those find none over the route's own places too: the boat anchors where
  anchoring is meant to be. The nearest places serve any schedule the others do, and more of
  them pass at higher water, so a plan that passes at some water level passes at every higher
  one.
- The boat may leave a place as soon as it is back from the detour, besides the slot
  boundaries.
- The offered route goes out to the place and back, the piece after the wait starting at the
  place; each wait names its `place` (`user`, `anchorage`, `route`).

Still to come: waiting off the route farther than a detour, which needs the time-dependent
search over the quadtree's leaves, state (leaf, arrival slot), in place of the candidate route.

### 4.4 R4: risk, alternatives, air draft, rules

- **Cost** = distance × (1 + α · P / threshold), so routes keep away from the margin; swept
  areas (`SWPARE`) carry little σ and are preferred on that alone. P is the square's box verdict
  risk and the threshold the accepted probability. A free square whose risk adds more than
  `riskSplit` (0.1) to its cost per metre is split, down to `riskCell` (80 m), to find the
  clearer water in it, and a direct line that passes but weighs as much is searched around. With
  a risk cost, A\* is plain (greed 1): weighted A\*'s slack of 25 % would swallow a preference
  this small. String pulling prices each shortcut it tries at its own verdict, as the search
  prices water with that verdict (a leg's risk is its worst point, so the price is pessimistic),
  takes one only when it costs no more than the path it replaces, and of those the one whose
  cost with the path's on to the end is lowest, not the farthest: pulling does not draw the
  route back to the margin. At weight 0 pulling is as in §4.1.
- **Risk budget:** the product of each leg's (1 − P) stays above 1 − budget. Every offered route
  states its risk, 1 − Π(1 − P); a route over `riskBudget` is refused with both numbers.
- **Alternatives:** shortest (α = 0), balanced (α = 2) and safest (α = 10, plus a fairway
  preference once the rules below give one), each searched and proved as a plan of its own at the
  plan's work limit. The reply is the first within the budget, in that order, with every
  alternative listed by its length, risk, status and legs, or its reason; `sameAs` where one
  repeats an earlier route, and `dominatedBy` where one is no shorter and no less risky than an
  earlier one. The search sees risk at its squares' box verdicts, a square and its buffer, which
  in a narrow channel near the threshold are coarser than a leg's corridor; a larger weight can
  then find no safer route, and the listing says so rather than calling it safer. Alternatives
  are planned at one departure: not with `latestDeparture`.
- **Air draft** from the request's `airHeight`, else signalk-underkeel's vessel (its Air height
  setting or `design.airHeight`): blocked under a bridge or an overhead cable or pipe whose
  clearance minus the water level rise above its datum is below air height plus 0.5 m.
  signalk-underkeel holds every box, leg and route check to it, and to the hard rules below, at
  the window's highest water (its plan §4.11, feature `objects`), so a square under a bridge too
  low for the mast is never free, and its flags, `AIR_DRAFT` and `CLEARANCE_UNKNOWN`, are not
  ones the fallback crosses. A request with an air height to a provider without `objects` is
  refused (503) rather than planned past the bridges; a trip planned on an index the provider
  prepared for it keeps the provider's `objects`. Sessions also list the chart objects in a box,
  for the preferences below; signalk-underkeel's planning API (its plan §4.11) defines that
  listing and its limits.
- **Hard rules:** an area where entry is prohibited fails (`ENTRY_PROHIBITED`), and so does a leg
  that sails a traffic lane against its direction rather than along it or across it
  (`TSS_WRONG_WAY`). Both are signalk-underkeel's verdicts, by the tolerances its route check
  defines (its plan §4.11 and `docs/HOW-IT-WORKS.md`), so the planner never judges a lane's
  direction itself; the search crosses neither flag. A box in a lane has no course, so the search
  may plan along a lane the wrong way, and the proof refuses it at the leg. Flags that only name water (`TRAFFIC_LANE`, `ENTRY_RESTRICTED`,
  `AREA_TO_BE_AVOIDED`) are crossed as their verdicts allow.
- **Preference lines (R4c),** asked for with `preferLines`: the lines a session lists
  (`objects`) of class `NAVLNE`, `RECTRC`, `NAVLINE` (a fairway's navigation line, such as the
  FTIA's) and `TRACK` (the boat's own passages) are kept to (`src/search/prefer.ts`), but not a
  navigation line laid out for less than the request's draft (`designDraft`). Water whose
  square's centre lies within reach of a line (`preferReach`) costs what it would anyway, and
  any other a little more per metre (`preferWeight`): a discount on the lines that keeps every
  weight at least 1, as A*'s heuristic needs, so a route keeps to a line where the detour costs
  less than that weight's share of the distance. A free square only partly near a line is split
  down to the risk cost's resolution; the lines' segments, clipped to the search region, are kept
  in a grid, so each test reads only those near it. A\* runs with a small slack (`FINE_GREED`)
  wherever a weight carries a preference, a risk cost or lines, so every preference worth more
  than that is kept. The values are `src/plan/options.ts`'s and `src/plan/search.ts`'s. String pulling prices a shortcut by the share of it
  off the lines, as the squares it crosses are counted; a fallback route without a risk cost is
  straightened by its own rule, since pricing a whole leg at its verdict let no shortcut through
  risky water and left Miami's Bayside route 115 legs long. A two-way line (`twoWay`) is moved
  `starboardOffset` to starboard of the way the boat sails it, from its end nearer the start and
  on through its bends (COLREG rule 9); a leading line is followed as charted. Decided: off by default, until field
  trials show the lines make routes better and not only different; on the Turku trial with the
  FTIA's 474 lines the route keeps to them at 20.0 nm against 19.8 nm, for 9.4 M work units
  against 5.8 M (`turku-guest-harbours-b-lines`). Decided against: a cost per turn, which A\*
  over squares cannot price without a heading in its state, and string pulling already keeps
  turns few; and offsetting within `FAIRWY` areas, which chart no centreline, where a
  navigation line gives one.
- **Finnish fairway data:** Finnish Transport Infrastructure Agency open data (fairway areas and
  navigation lines, CC BY 4.0) as preference lines, read through underkeel's WFS client and served
  as `NAVLINE` objects, two-way.
- **Own tracks:** passages the boat has logged (underkeel's living chart), served as `TRACK`
  objects only at a water level no lower than when they were sailed, so a track lowers cost, never
  risk (invariant 6).

### 4.5 R5: Freeboard UX and upstream

- Extension panel: start at the vessel (`navigation.position` from the host's Signal K stream)
  or at the first point of a selected route, destination at its last point; alternatives drawn
  as a data overlay (`alternatives`, the written one marked), each listed with its length, risk
  and status and a button that writes it instead; the chosen one written with `route.replace` as
  an unsaved draft; the timed plan and each leg's flags in words in the panel. Alternatives plan
  at one departure, so the panel leaves its wait for the tide out while they are asked for.
- Interactive editing: when exactly one point of the route the panel wrote moves (`route.dirty`
  from the host), the legs from the point before it to it and from it to the point after are
  planned again, each as a plan of its own, and spliced in; the dragged point stays where it was
  left. Each leg is checked at the time the boat sails it, without waiting for the tide: the leg
  after the point from the first one's `arrival`. A leg that cannot be planned so, needing a wait
  among other reasons, leaves the drag as it is, with the reason, and a route changed again
  meanwhile is not written. The panel notes the whole route is then to be planned
  again for its check.
- `routePlan` in the `navigationSafety` services contract: the manifest offers it
  (`services.navigationSafety.provides: ["routePlan"]`, `POST {base}/plan` with the request and
  reply of §5); Freeboard core and signalk-underkeel's copy of the contract schema list it next.
- **Panel trial** (`npm run trial:panel`, `scripts/trials/panel-trial.js`): the panel in
  Chromium, hosted by the bus's own host implementation over one route, planning through
  signalk-underkeel's planning API on the field trials' charts. It plans with alternatives,
  writes another, drags a waypoint and waits for its legs to be planned again. Freeboard itself
  is the release trial (R5's exit).

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
  "draft": 1.9, // optional override
  "airHeight": 17, // optional, metres above the waterline; default underkeel's vessel
  "latestDeparture": "2026-11-18T19:00:00Z", // optional: wait for the tide up to this, ≤ 24 h
  "waitEnRoute": true, // optional, with latestDeparture: wait on the way too (§4.3 R3b)
  "waitPoints": [[22.05, 60.01]], // optional, with waitEnRoute: where to rather wait (§4.3 R3c)
  "riskWeight": 2, // optional, 0..100, default 0: the risk cost's α (§4.4)
  "riskBudget": 0.01 // optional: refuse a route whose risk is over this
}
```

With `alternatives`, which plans at one departure and sets its own risk weights:

```jsonc
{
  "from": [22.1, 60.2],
  "to": [22.31, 60.27],
  "riskBudget": 0.01,
  "alternatives": true // not with riskWeight or latestDeparture (§4.4)
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
  "arrival": "…", // when the boat reaches the end: departure, waits and sailing time
  "risk": 0.0021, // 1 − Π(1 − P) over the legs
  "riskWeight": 0,
  "status": "ok", // worst leg status
  // Underkeel's route-check legs, numbered through, each with its `part` ("harbour" or
  // "route"), `xteLimit` and, for a berth leg, `berth: true`; `parts` spans them.
  "check": {
    "legs": [/* … */],
    "parts": [{ "part": "harbour", "end": "start", "xteLimit": 0, "legs": [0, 4] }]
  },
  "underway": "ok", // with berth legs: the worst status of the other legs
  // With latestDeparture, when the plan waits for the tide (§4.3):
  "departure": "2026-11-18T13:15:00.000Z",
  "gate": {
    "requested": "…",
    "departure": "…",
    "waitMinutes": 375,
    "legs": [3],
    // With waitEnRoute, each wait on the way, in order:
    "waits": [
      { "at": [22.04, 60.0], "place": "anchorage", "arrive": "…", "leave": "…", "minutes": 678 }
    ]
  },
  "berths": [{ "end": "start", "leg": 0, "length": 12 }],
  "direct": { "status": "fail", "worst": [22.21, 60.24] }, // the straight line's check
  // With alternatives: which was offered, and each with its length and risk or its reason.
  "chosen": "shortest",
  "alternatives": [
    {
      "name": "shortest",
      "riskWeight": 0,
      "route": {/* … */},
      "length": 14250,
      "risk": 0.0021,
      "status": "ok"
    },
    {
      "name": "balanced",
      "riskWeight": 2,
      "route": {/* … */},
      "length": 14610,
      "risk": 0.0004,
      "status": "ok"
    },
    {
      "name": "safest",
      "riskWeight": 10,
      "route": {/* … */},
      "length": 14610,
      "risk": 0.0004,
      "status": "ok",
      "sameAs": "balanced"
    }
  ],
  "work": 182340
}
```

Reply 422 when no route exists, with `reason` and, when the search met water the check cannot
verify, `unverifiedSquares`: how many one-unit squares it was. Reply 503 when the planning API
is missing or the index is not ready, and with `preparing: true` and `Retry-After` while
underkeel builds the trip's planning box (§4.2). Reply 413 when the trip's region is too large
for underkeel to build on the machine.

## 6. Performance budget

Raspberry Pi 4 is the reference. One plan may do 1 200 000 underkeel work units (about 3 s on a
Pi 4 at underkeel's calibration, 0.4 s on an i5 laptop); a trip planned in a corridor may do
more, in proportion to its length (§4.2). A\* stops at 80 % of that and string
pulling at the whole. A plan's stages (the main search, harbour stages, the main search again)
draw on that one budget, each with what the stages before it left. The proof is underkeel's
route check, bounded by `/route-check`'s own limits; its work is not counted in the plan's. Work
is counted, never timed, so a request gives the same answer on any machine.

**Where the work goes** (`npm run trial -- --profile`): nine tenths of it is boxes under 50 m, at
the shores the search meets. R2 cuts those by asking about fewer of them:

- the start and destination joins and the harbour handovers search the squares near an end in
  order of distance and stop once they have enough candidates (`QuadTree.nearest`), instead of
  classifying every square within the access or harbour radius (`src/plan/options.ts`);
- A\* classifies a square when it reaches it, not when it reaches a neighbour (lazy A\*);
- A\* is weighted (`greed` 1.25);
- the strict search crosses marginal water at a cost instead of failing and handing the whole
  route to the fallback;
- an end the search cannot join goes to its harbour stage before any whole-route fallback,
  whose risk-weighted search reaches across the whole region.

With these the field trials' work fell on every case but the Bayside fallback, most where a
harbour end had sent the whole route to the fallback; `docs/trials.md` records each case's work.

Still open: a 20 nm passage through the archipelago is three to four times the budget, and a
fallback route across risky water (Bayside, through unassessed water) reaches across its whole
region. The trials cap each case's work (`workAtMost`) so a change cannot give this back
unnoticed.

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
| R2  | Planning box beyond the chart box                                                        | 50 nm plan within the memory budget of a 2 GB machine (Raspberry Pi 4 2 GB)              |
| R3  | Time slots, waiting places, timed plan                                                   | Wadden Sea fixture: a plan that waits for the tide where every fixed departure fails     |
| R4  | Risk cost and budget, alternatives, air draft, S-57 rules, FTIA lines, own tracks        | each alternative states length and risk; bridge fixture blocks a tall mast at high water |
| R5  | Freeboard panel, interactive re-plan, `routePlan` service contract                       | live Freeboard trial                                                                     |

## 9. Open questions

- The Pi 4 work-unit calibration is underkeel's laptop measurement times 3–5 (its plan §10);
  the planner inherits that until measured on a Pi.
- FTIA open data licence attribution must show in the panel; confirm the exact wording.
- Whether waiting in deep water off the fairway needs a minimum distance from the fairway edge
  beyond the swing radius.
