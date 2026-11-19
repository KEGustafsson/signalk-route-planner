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

| Case                      | Assumed CATZOC | Result (2026-11-19)                                   |  Work |
| ------------------------- | -------------- | ----------------------------------------------------- | ----: |
| `turku-guest-harbours-b`  | B              | 19.8 nm, 39 legs: harbour stage, route, harbour stage | 5.8 M |
| `turku-guest-harbours-a1` | A1             | 19.9 nm, 45 legs: harbour stage, route, harbour stage | 5.4 M |

- The Aura river is one 0–10 m depth area in the WFS, so its harbour-stage legs come back
  `fail`, at a charted 0 m. The river is deep enough on the chart; the WFS does not say so.
- The Nauvo end reaches the guest harbour through its harbour stage, `unverified`.

## Miami from sea (Florida)

Data: NOAA ENC cells `US4FL2AI`, `US5MIACC` and `US5MIACB`, official and public domain. The
start is at sea off South Pointe, 25.760871 N, 80.125431 W.

| Case                        | Result (2026-11-19)                                                     |   Work |
| --------------------------- | ----------------------------------------------------------------------- | -----: |
| `miami-fisher-island-basin` | 1.02 nm, 4 legs through Government Cut, all `ok`                        |  1.9 M |
| `miami-bayside`             | 3.67 nm, route then harbour stage; unassessed water in it is marked     | 17.0 M |
| `miami-beach-marina`        | refused: Meloy Channel is dredged to 1.7 m (2025), shallower than 1.8 m |  2.4 M |

`miami-meloy-channel-tide` plans into Meloy Channel with a modelled tide (0.0–0.7 m above
MLLW) and up to 12 h to wait. The gate finds the route's last leg touches a 0 m band at the bank,
which no state of the water level clears, and refuses naming that leg: the gate does not trade a
wait for a leg the tide cannot open.

- Miami Beach Marina is a pier field. The 10 m harbour corridor touches a pier almost
  everywhere in its basin, and the only way in, Meloy Channel, is shallower than the draft at
  chart datum. The refusal is the right answer; a shallower draft or a tide gate (R3) would
  change it.

## R2's exit trial: Turku guest harbour → Utö, 50 nm (Finland)

`npm run trial:r2` (`scripts/trials/r2-exit.js`) plans a trip past any planning box on
signalk-underkeel's own planning boxes, depth survey and build processes, with a 10 km chart box
around the start, as the plugin runs them. Run it in a memory limit to measure a machine's budget:
the build processes size their heaps from it, and `TRIAL_CGROUP` names the cgroup whose peak is
reported. The survey is kept in `data/trials/r2-exit/` and used again by the next run.

| Run (2026-11-19), 2 GB limit, 512 MB build heap | Result                                                     |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Planning boxes                                  | search region 33 039 km², trip region 4 972 km²: both 413  |
| Depth survey                                    | 258 s, about 30 000 depth areas                            |
| Corridor (1.5 km each side, 3.5 km at the ends) | 81 boxes, 497 km² (cap 784 km²), built in 298 s            |
| Plan                                            | 200: 53.3 nm, 58 legs, 10.1 M work, 6.5 s                  |
| Memory                                          | peak 375 MB for the plugin process and its build processes |

- The route runs down the fairway past Nauvo and Korpo and across the open sea to Utö, its
  route legs `unverified` (the WFS is not for navigation).
- At the start, the harbour stage and the route's first two legs come back `fail` in the Aura
  river, a single 0–10 m depth area in the WFS, as in the Turku → Nauvo cases.
- The trip is past `DEFAULT_PLAN.maxDistance` and its work budget; the trial raises both.
- The download is most of the time: the WFS answers a box with whole areas, about 1 MB/s.
