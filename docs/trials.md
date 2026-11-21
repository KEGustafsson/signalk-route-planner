# Field trials

`npm test` runs the search on a synthetic chart. The field trials run it on real chart data, in
two areas with different data and different harbours. They show what a change does on water that
exists.

```sh
npm run build                     # this package's lib/
(cd ../signalk-underkeel && npm run build)
npm run trial                     # every case
npm run trial -- miami            # one area, or one case by name
```

The trials need network. They download the Traficom WFS and NOAA ENC cells once into
`data/trials/` (git-ignored), and they need a built signalk-underkeel 0.7.0 or later checkout
next to this one, or at `UNDERKEEL_DIR`. Each case writes its reply to
`data/trials/<case>.json` and its legs with their statuses to `data/trials/<case>.geojson`. The
run exits 1 when a result does not meet the expectation in `scripts/trials/trials.json`.

Every case is planned for a 1.8 m draft, at 3 m/s, and by default with the water at chart datum
(σ 0.2 m), so the results do not depend on the tide or the day; a case may model a tide instead
(`miami-meloy-channel-tide`). The work limit is raised, so a trial tells
whether the search finds a route apart from whether it does so within the Raspberry Pi budget
(`docs/DEVELOPMENT-PLAN.md` §6).

Each case also caps its work (`workAtMost`), in underkeel work units. The cap catches a change
that makes the search do more work than it did; it does not hold a case to the plan's normal
budget (`DEFAULT_PLAN.maxWork` in `src/plan/options.ts`, `docs/DEVELOPMENT-PLAN.md` §6), which
the raised limit lifts. `npm run trial -- --profile` shows where the work went.

Run the trials for every change to the search or the plan. When a change moves a result for a
good reason, update the expectation and the table below in the same pull request.

## Turku guest harbour → Nauvo guest harbour (Finland)

Data: the Traficom INSPIRE WFS (`DepthArea_A`, `Sounding_P`) through signalk-underkeel's WFS
client. It is not for navigation, so every leg is at best `unverified`. It carries no survey
quality, so each case assumes a CATZOC.

| Case                      | Assumed CATZOC | Result (2026-11-21)                                   | Work (unsteered) |
| ------------------------- | -------------- | ----------------------------------------------------- | ---------------: |
| `turku-guest-harbours-b`  | B              | 20.2 nm, 37 legs: harbour stage, route, harbour stage |    4.3 M (5.8 M) |
| `turku-guest-harbours-a1` | A1             | 21.3 nm, 40 legs: harbour stage, route, harbour stage |    4.2 M (5.4 M) |

- Work (unsteered) is the same case with steering off (`steerShare: 0`), as planned before the
  search was steered along a coarse path (`src/plan/steer.ts`).
- The A1 case's route is the fallback's. Its guide counts the path through coarse squares that
  may hold no way through at `steerRisk`, so it keeps to water sure all over: 21.3 nm against
  19.9 nm unsteered, all of it `unverified` either way.

- The Aura river is one 0–10 m depth area in the WFS, so its harbour-stage legs come back
  `fail`, at a charted 0 m. The river is deep enough on the chart; the WFS does not say so.
- The Nauvo end reaches the guest harbour through its harbour stage, `unverified`.

## Miami from sea (Florida)

Data: NOAA ENC cells `US4FL2AI`, `US5MIACC` and `US5MIACB`, official and public domain. The
start is at sea off South Pointe, 25.760871 N, 80.125431 W.

| Case                        | Result (2026-11-21)                                                     | Work (unsteered) |
| --------------------------- | ----------------------------------------------------------------------- | ---------------: |
| `miami-fisher-island-basin` | 1.02 nm, 4 legs through Government Cut, all `ok`                        |    1.9 M (1.9 M) |
| `miami-bayside`             | 3.71 nm, route then harbour stage; unassessed water in it is marked     |  11.0 M (17.0 M) |
| `miami-beach-marina`        | refused: Meloy Channel is dredged to 1.7 m (2025), shallower than 1.8 m |    2.4 M (2.4 M) |

- Bayside's route is the fallback's: risk 0.984 against 0.991 unsteered, with 4 `fail` legs
  in the route against 2. The short Fisher Island and Beach Marina trips share a leaf or finish
  before steering pays, so their work is unchanged.

`miami-meloy-channel-tide` plans into Meloy Channel with a modelled tide (0.0–0.7 m above
MLLW) and up to 12 h to wait. The gate finds the route's last leg touches a 0 m band at the bank,
which no state of the water level clears, and refuses naming that leg: the gate does not trade a
wait for a leg the tide cannot open.

`turku-guest-harbours-b-lines` plans Turku to Nauvo with `preferLines` on the WFS cell with the
FTIA's navigation lines (474 of them in the area): 20.0 nm in 41 legs, keeping to the lines,
against 20.2 nm in 37 without them, for 9.4 M work units against 4.3 M and 7 s against 2 s. A
search with lines is not steered: the guide would drown their discount.

`miami-fisher-island-alternatives` plans the same trip with `alternatives` (R4). The shortest
route is 1894 m at risk 0.031; the balanced one (α = 2) 1903 m at 0.026, every leg `ok`. The safest
(α = 10) comes out 1900 m at 0.050 with a marginal leg: in Government Cut the squares' box
verdicts all read marginal, coarser than a leg's corridor, so the larger weight finds no safer
line, and the reply marks it `dominatedBy: "shortest"` rather than offering it as safer. The three
plans took 6.1 M work units together.

- Miami Beach Marina is a pier field. The 10 m harbour corridor touches a pier almost
  everywhere in its basin, and the only way in, Meloy Channel, is shallower than the draft at
  chart datum. The refusal is the right answer; a shallower draft or a tide gate (R3) would
  change it.

## R2's exit trial: Turku guest harbour → Utö, 50 nm (Finland)

`npm run trial:r2` (`scripts/trials/r2-exit.js`) plans a trip past any planning box on
signalk-underkeel's own planning boxes, depth survey and build processes, with a chart box around
the start, as the plugin runs them. Run it in a memory limit to measure a machine's budget: the
build processes size their heaps from it, and `TRIAL_CGROUP` names the cgroup whose peak is
reported. The script's header says what it keeps between runs.

| Run (2026-11-19), 2 GB limit, 512 MB build heap | Result                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| Planning boxes                                  | search region 33 039 km², trip region 4 972 km²: both 413              |
| Depth survey                                    | 258 s, about 30 000 depth areas                                        |
| Corridor (1.5 km each side, 3.5 km at the ends) | 81 boxes, 497 km² (cap 784 km²), built in 219–298 s                    |
| Plan                                            | 200: 53.2 nm, 79 legs, 7.7 M work of the 10.5 M its limits give, 4.8 s |
| Memory                                          | peak 441 MB for the plugin process and its build processes             |

- The route runs down the fairway past Nauvo and Korpo and across the open sea to Utö, its
  route legs `unverified` (the WFS is not for navigation).
- At the start, the harbour stage and the route's first two legs come back `fail` in the Aura
  river, a single 0–10 m depth area in the WFS, as in the Turku → Nauvo cases.
- The trial plans with the limits `/plan` gives the trip (`limitsFor`): a corridor's reach, and
  work in proportion to its length. Before the search asked about no square past the corridor and
  searched the square around its boxes, the same plan took 10.1 M work.
- `--profile` shows where the work goes: most of it is boxes under 50 m along the archipelago's
  shores, and the harbour stages at the start.
- The search in a corridor is not steered: the corridor is its coarse path already. The plan's
  work is the same with steering on or off (2026-11-21).
- The download is most of the time: the WFS answers a box with whole areas, about 1 MB/s.

## The panel in a chart host (R5)

`npm run trial:panel` runs the panel in Chromium, hosted by signalk-plotterext-bus's own host
implementation (`scripts/trials/panel-host.html`), on one route in Miami, and answers `/plan`
with the planner on the field trials' NOAA cells through signalk-underkeel's planning API. It
plans with alternatives, checks the overlay data the panel hands the host (the host draws no
map) and the panel's lists, writes another alternative, and drags a planned waypoint to see the
legs beside it planned again. The steps and what each checks are in
`scripts/trials/panel-trial.js`; it saves screenshots in `data/trials/`.

## The panel in Freeboard (R5's exit)

On 2026-11-21 the panel ran in Freeboard-SK 3.4.1 on a Signal K server 2.37.0, beside
signalk-underkeel 0.8.0 and signalk-charts-provider-simple 2.22.0, with the server's resources
provider holding the route. Charts Provider converted the three Miami NOAA cells from a folder on
the server, keeping their ENC cells, and signalk-underkeel built its index from them. Nothing was
stubbed: Freeboard found the planner as a plotter extension, its toolbar button opened the
panel, and the planner planned through signalk-underkeel's planning API.

| Step                                                                           | Result                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| A route in Freeboard, from sea off South Pointe to the mouth of Government Cut | the panel lists it; Freeboard draws it on the NOAA chart                              |
| Plan it with alternatives                                                      | 0.5 nm in 2 legs, `ok`; shortest, balanced and safest the same route                  |
| The plan written back                                                          | Freeboard's route takes the planned points as an unsaved change, for its route editor |
| The alternatives overlay                                                       | drawn on Freeboard's map                                                              |

- Within the plan's normal work budget (`docs/DEVELOPMENT-PLAN.md` §6) the planner refuses
  `miami-fisher-island-basin` on the live server: that case takes 1.9 M work units, the budget
  1.2 M. The field trials raise the limit; a live server does not, so this trial plans the
  shorter passage, which takes 1.4 M for its three alternatives.
- With the alternatives all the same route, no **Use** button is offered, so writing another
  alternative is covered by the panel trial above, not here.
- Dragging a waypoint in Freeboard's route editor was not shown here: a scripted drag in
  Freeboard's modify mode moved no point. The panel trial covers the re-plan.
- Plugins start in no set order: the planner's status waits for signalk-underkeel and turns to
  ready once its planning API appears.
