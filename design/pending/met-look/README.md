# The Met's look (v1205)

Hand-modelled in www/js/landmarks3d.js over NYC Open Data's footprint (BIN 1083810, roof 26.8 m), drawn instead of the
generic block for the building tagged `"lm":"met"` in www/data/buildings/nyc-upper-west-side.json. The user (2026-11-22):
"I expect we'll want to recursively improve the look of the MET".

- round1/: limestone body, Hunt pavilion (3 arches, 4 column pairs, uncarved blocks, cornice), banners, steps, fountains.
- round2/: wings along Fifth: base, cornice, windows, pilasters. m2_corner = the walker at 83rd & Fifth.

render.mjs renders the views (a headless Chrome on :9568, www on :8791; clears the site's caches first: a stale cached
buildings file hid the Met at first).
