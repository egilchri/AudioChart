#!/usr/bin/env node
// Builds www/data/cruise_ships.json (v933): where and when cruise ships come into Penobscot Bay, for the
// 3D views. Each track is planned by the app's own router (router.js) at the ship's draft, so it keeps to
// water deep enough for her and clear of the charted rocks, as a pilot would; a track that comes back as a
// straight line, or crosses land, stops the build.
//
//   node preprocess/build_cruise_tracks.js
//
// Sources for the pattern (checked 2026-10-18):
// - Rockland: large ships (over 500 passengers) only in September and October, six calls a year at most;
//   they anchor outside the harbour (Broad Cove off Owls Head is the pilots' choice) and tender ashore,
//   about 07:00-17:00. 2026 calls listed by cruisedig.com/ports/rockland-maine (sources disagree a little).
//   Bangor Daily News, 2018-03-09; Maine Public, 2024-09-01; cruisemapper.com.
// - Bar Harbor: about 64 calls, 47,000 passengers, 17 May to late October 2026; the ships anchor in
//   Frenchman Bay (the chart's General Anchorage A and B, B behind Bar Island) and tender to the town pier.
//   Mount Desert Islander, 2026; Bangor Daily News, 2026-05-15.
// - Small coastal ships (American Cruise Lines' Maine Coast & Harbors): Camden, Searsport (the Penobscot
//   Marine Museum), Bar Harbor, Bucksport. americancruiselines.com; jetsetterguide.com 2026 itineraries.
//   (Camden to Bar Harbor runs through the Mount Desert area, where the router can't yet plan; so the
//   small ship's leg here is Camden to Searsport.)
const { installNodeQueryEnv } = require('../test/helpers/node_query_env.js');
const path = require('path'), fs = require('fs');
installNodeQueryEnv(path.join(__dirname, '..', 'www', 'data'));

const VESSELS = {
  large: { name: 'cruise ship', length_m: 300, beam_m: 37, draft_ft: 28, knots: 12 },
  small: { name: 'small cruise ship', length_m: 95, beam_m: 15, draft_ft: 10, knots: 10 },
};
const CALLS = [
  { id: 'rockland', vessel: 'large', port: 'Rockland', where: 'at anchor off Broad Cove, outside Rockland Harbor',
    from: { lat: 43.90, lon: -69.03 }, to: { lat: 44.098, lon: -69.057 },   // in from the sea past Two Bush Island; 26 m at the anchorage
    arrive: '07:00', depart: '17:00',
    dates: ['2026-09-06', '2026-09-15', '2026-09-18', '2026-09-29', '2026-10-04', '2026-10-10', '2026-10-19'] },
  { id: 'barharbor', vessel: 'large', port: 'Bar Harbor', where: 'at anchor in Frenchman Bay off Bar Harbor',
    from: { lat: 44.25, lon: -68.10 }, to: { lat: 44.3918, lon: -68.1914 },   // in past Egg Rock; General Anchorage A, 27 m
    arrive: '07:00', depart: '17:00', season: ['05-17', '10-25'], chance: 0.38 },
  { id: 'camden-searsport', vessel: 'small', port: 'Searsport', where: 'bound from Camden to Searsport',
    from: { lat: 44.205, lon: -69.045 }, to: { lat: 44.448, lon: -68.918 },   // outside Curtis Island to Searsport Harbor
    leave: '08:00', stay: '18:00', season: ['06-01', '10-25'], chance: 0.3 },
];

(async () => {
  const Query = await import('../www/js/query.js'), Router = await import('../www/js/router.js');
  await Query.loadData(44.103, -69.088); await Query.whenLandLoaded();
  for (let t = 0; (Query.channels === null || !Query.getDepthZones()) && t < 200; t++) await new Promise(r => setTimeout(r, 50));
  const calls = [];
  for (const c of CALLS) {
    const V = VESSELS[c.vessel];
    const pts = await Router.autoRouteProg(c.from, c.to, () => {}, () => {}, false, V.draft_ft, 0, null, null, 30000);
    let land = false; for (let i = 1; i < pts.length; i++) if (Query.landBlocks(pts[i - 1].lon, pts[i - 1].lat, pts[i].lon, pts[i].lat)) land = true;
    if (pts.length <= 2 || land) throw new Error(`${c.id}: no proper track (${pts.length} points${land ? ', crosses land' : ''})`);
    const nm = pts.reduce((s, p, i) => i ? s + Query.distanceNm(pts[i - 1].lon, pts[i - 1].lat, p.lon, p.lat) : 0, 0);
    console.log(`${c.id}: ${nm.toFixed(1)} nm, ${pts.length} points`);
    const { from, to, ...rest } = c;
    calls.push({ ...rest, nm: +nm.toFixed(2), track: pts.map(p => [+p.lon.toFixed(5), +p.lat.toFixed(5)]) });
  }
  const out = {
    note: 'Cruise ships for the 3D views; tracks planned by router.js at each ship\'s draft (preprocess/build_cruise_tracks.js, which lists the sources). Times are local. A call with dates comes on those days; one with a season and a chance comes on that share of the season\'s days, the same days for everyone.',
    vessels: VESSELS, calls,
  };
  fs.writeFileSync(path.join(__dirname, '..', 'www', 'data', 'cruise_ships.json'), JSON.stringify(out) + '\n');
  process.exit(0);
})().catch(err => { console.error(err.message); process.exit(1); });
