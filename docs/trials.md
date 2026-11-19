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

Every case is planned for a 1.8 m draft, at 3 m/s, with the water at chart datum (σ 0.2 m), so
the results do not depend on the tide or the day. The work limit is raised, so a trial tells
whether the search finds a route apart from whether it does so within the Raspberry Pi budget
(`docs/DEVELOPMENT-PLAN.md` §6).

Run the trials for every change to the search or the plan. When a change moves a result for a
good reason, update the expectation and the table below in the same pull request.

## Turku guest harbour → Nauvo guest harbour (Finland)

Data: the Traficom INSPIRE WFS (`DepthArea_A`, `Sounding_P`) through signalk-underkeel's WFS
client. It is not for navigation, so every leg is at best `unverified`. It carries no survey
quality, so each case assumes a CATZOC.

| Case                      | Assumed CATZOC | Result (2026-11-18)                                                     |
| ------------------------- | -------------- | ----------------------------------------------------------------------- |
| `turku-guest-harbours-b`  | B              | 19.9 nm, 40 legs: harbour stage, route, harbour stage                   |
| `turku-guest-harbours-a1` | A1             | 19.2 nm, 44 legs: the route along the Rajakari–Turku fairway centreline |

- The Aura river is one 0–10 m depth area in the WFS, so its harbour-stage legs come back
  `fail`, at a charted 0 m. The river is deep enough on the chart; the WFS does not say so.
- The Nauvo end reaches the guest harbour through its harbour stage, `unverified`.

## Miami from sea (Florida)

Data: NOAA ENC cells `US4FL2AI`, `US5MIACC` and `US5MIACB`, official and public domain. The
start is at sea off South Pointe, 25.760871 N, 80.125431 W.

| Case                        | Result (2026-11-18)                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `miami-fisher-island-basin` | 1.03 nm, 10 legs through Government Cut: 8 `ok`, 2 `marginal`                        |
| `miami-bayside`             | 3.68 nm, 30 legs; Fisherman's Channel and the basin are unassessed: 8 `fail`, marked |
| `miami-beach-marina`        | refused: Meloy Channel is dredged to 1.7 m (2025), shallower than 1.8 m              |

- Miami Beach Marina is a pier field. The 10 m harbour corridor touches a pier almost
  everywhere in its basin, and the only way in, Meloy Channel, is shallower than the draft at
  chart datum. The refusal is the right answer; a shallower draft or a tide gate (R3) would
  change it.
