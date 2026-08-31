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
