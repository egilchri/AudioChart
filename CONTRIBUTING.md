# Contributing to AudioChart

## Running it locally

```
cd server && python3 server.py
```

Then open `http://localhost:8080/` in a browser. This is a plain static
PWA (no build step) served by a small Python dev server — editing any
file under `www/` takes effect on reload.

See [SPEC.md](SPEC.md) for the full architecture (hosted vs. local-server
modes, module responsibilities, chart data pipeline).

## Running the tests

```
node test/test_parser.js
node test/test_query.js
node test/test_channel_routing.js         # regression suite, real chart data
node test/test_route_hazard_clearance.js  # regression suite, real chart data
```

The first two are fast unit tests and must pass. The last two run against
real production chart data and currently have some known-failing/
EXPERIMENTAL cases (see the test output) — CI runs them but doesn't block
on them yet. If your change affects routing or hazard logic, run them
anyway and call out any change in their results in your PR.

## Opening a pull request

- Use the PR template — describe what changed, why, and how you tested it.
- Commit messages here are imperative and one-line (e.g. `Fix hazard
  clearance check for buoy-chain channels`) — you don't need to add a
  `(vNNN)` version tag; the maintainer bumps `www/js/version.js` on merge.
- CI (`.github/workflows/ci.yml`) runs automatically on your PR and must
  pass before merging.

## AudioChart and Ted's Birdseye

The navigation app and Ted's Birdseye share one engine (Bird's-eye, `www/bay3d.html`), but boaters
should never pay for the armchair layer: the trains, the T's tunnels and stations, aircraft, freeway
traffic, airports, and the SF, New York and Boston bays.

- **Code.** `www/js/bay3d.js` loads the armchair layer with `import()` only where it's wanted
  (`loadArmchair`). Never import those modules statically from anything `bay3d.js` or `helm3d.js`
  imports. `test/test_birdseye_static.js` (in CI) fails if you do. Before a release that touches
  Bird's-eye, also run `test/test_birdseye_footprint.mjs` in headless Chrome (instructions at its top).
- **Versions.** Releases share one counter. A release that changes only the armchair layer or its
  data bumps `www/js/birdseye_version.js` alone, so AudioChart's `www/js/version.js` and `www/sw.js`
  stay put and boaters get no update. A release that changes anything boaters load bumps all three.
  Tag Bird's-eye-only CHANGELOG entries "(Bird's-eye only)".
- **Relays.** Boaters' live AIS comes from `audiochart-ais` (Maine's bays). Ted's Birdseye's armchair
  bays, trains and aircraft come from `birdseye-relay` (`relay/ais`, `wrangler deploy --env birdseye`).
  Bird's-eye work deploys only that one, and bumps its `ARMCHAIR_V`, never `RELAY_V`.
