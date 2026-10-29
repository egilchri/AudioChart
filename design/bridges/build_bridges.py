#!/usr/bin/env python3
"""Bridges for Bird's-eye (v1020, requested: "don't forget to put in the Golden Gate bridge and the other bridges").

    python3 -I design/bridges/build_bridges.py sf-bay [OSM=<cached overpass json>]

Writes www/data/bridges/<region>.json, which bay3d.js (bridges3d.js) draws. Each bridge's line is OpenStreetMap's
(so it lies on the bridge in the aerial photo); its heights come from the NOAA chart (each span's charted vertical
clearance, BRIDGE.VERCLR, and the towers' and piers' positions, PYLONS) and from the bridge's published figures,
written below as knots along it. The big ones are described by hand in SPECS: their kind (suspension, truss,
girder), towers, cables, trusses and colour. Every other road or rail bridge OSM has over charted water gets a plain
deck on piers at its charted clearance (a lift bridge its two towers).

Out: { made, credit, bridges: [{ name, kind, color, w, depth, pts: [[lon, lat, h | null], ...] (null: on the ground
there), piers: [[lon, lat, top], ...], towers: [{lon, lat, top, az, kind, w}], cables: [[[lon, lat, h, deckH], ...]],
truss: [{i0, i1, above: [m per point], below}], blocks: [{lon, lat, az, len, w, top}] }] }. Heights in metres above
the water (the terrain's NAVD 88, near enough).
"""
import glob
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

from osgeo import ogr
from shapely.geometry import LineString, Point, shape
from shapely.strtree import STRtree

ogr.UseExceptions()
ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../..'))
REGIONS = {
    'sf-bay': {'bbox': (37.42, -122.62, 38.17, -122.0), 'charts': '~/Documents/Charts/ENC/sf_bay_only'},
    # (v1028: the Portsmouth Harbor and Piscataqua River cells, linked from US_ME and US_NH)
    # (the region's land.geojson draws the river above Memorial Bridge as land, so its two big bridges there are
    # named as over water)
    'piscataqua': {'bbox': (42.88, -70.97, 43.22, -70.39), 'charts': '~/Documents/Charts/ENC/piscataqua_only',
                   'wet': {'Sarah Mildred Long Bridge', 'Piscataqua River Bridge'}},
    'new-york-harbor': {'bbox': (40.45, -74.30, 40.95, -73.65), 'charts': '~/Documents/Charts/ENC/nyc_only'},
}
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']

# ── The big bridges. `axis`: the coordinate their knots are given in (lat for a bridge running north-south, else
# lon); each knot [coord, h] is where the line crosses that coordinate. deck: [coord, h] the top of the deck (h None:
# the ground); towers/cables/blocks/truss/free likewise by coordinate. `ways`: OSM way ids in order, one list per
# carriageway; two lists are averaged into one centre line (a bridge carrying both directions side by side).
GG_ORANGE, STEEL, WHITE, CONCRETE, OLD_STEEL = 0xc0362c, 0x9aa3a8, 0xd9dde0, 0xbdbab2, 0x7f8a84
SPECS = [
    # New York Harbor (v1032, requested: "add proper towers for Brooklyn and Verrazzano bridges").
    # Brooklyn Bridge (1883): granite towers 84 m above the water, each with two pointed arches the roadway passes
    # through; main span 486 m between them (the chart's tower piers, 40.70759/-73.99873 and 40.70441/-73.99474, are
    # 487 m apart), side spans 283 m to the anchorages; 38.7 m clearance at mid-span (chart). The two one-way
    # carriageways are averaged into one line.
    {'name': 'Brooklyn Bridge', 'region': 'new-york-harbor', 'kind': 'suspension', 'color': 0xa99f8c, 'axis': 'lon', 'w': 26, 'depth': 5,
     'ways': [[432550257, 808611020, 46177152, 432550256, 808611043, 808611038, 298734351, 808611037, 808611027, 46116280, 46177116],
              [808611034, 122660450, 808611042, 808611041, 298734352, 808611046, 432550255, 808611021, 432550259]],
     'deck': [[-74.0030, None], [-74.00105, 27], [-73.99873, 37], [-73.99673, 44], [-73.99474, 37], [-73.99242, 27], [-73.9900, None]],
     'towers': [[-73.99873, 84, 'gothic'], [-73.99474, 84, 'gothic']],
     'cables': [[[-74.00105, 'deck'], [-73.99873, 'top'], [-73.99474, 'top'], [-73.99242, 'deck']]], 'sag_over': 2,
     'free': [[-74.00105, -73.99242]], 'span': 50,
     'blocks': [[-74.00105, 27, 40], [-73.99242, 27, 40]]},
    # Verrazzano-Narrows Bridge (1964): steel towers 211 m, main span 1,298 m (the chart's PYLONS, -74.05251 and
    # -74.03837, are 1,297 m apart), side spans 370 m to the anchorages, double decked on a 7.3 m truss; 65.5 m
    # clearance at mid-span (chart). The upper deck's two directions are averaged into one line.
    {'name': 'Verrazzano-Narrows Bridge', 'short': 'Verrazzano Bridge', 'region': 'new-york-harbor', 'kind': 'suspension', 'color': 0x9ea7a6,
     'axis': 'lon', 'w': 31, 'depth': 7.3,
     'ways': [[10670862, 46858872], [865473231]],
     'deck': [[-74.0590, None], [-74.05654, 60], [-74.05251, 68], [-74.04544, 73], [-74.03837, 68], [-74.03434, 60], [-74.0334, None]],
     'towers': [[-74.05251, 211, 'portal'], [-74.03837, 211, 'portal']],
     'cables': [[[-74.05654, 'deck'], [-74.05251, 'top'], [-74.03837, 'top'], [-74.03434, 'deck']]], 'sag_over': 2,
     'free': [[-74.05654, -74.03434]], 'span': 70,
     'blocks': [[-74.05654, 40, 50], [-74.03434, 40, 50]]},
    # George Washington Bridge (1931; v1059, reported: "The George Washington Bridge looks like it fell down": OSM has
    # it in halves, meeting mid-river, and each half was drawn as a plain deck ramped to the water at both its ends).
    # Steel towers 184 m (604 ft) above the water at the chart's PYLONS (-73.95877, the New Jersey one, and -73.9465,
    # 1,065 m apart; main span 1,067 m); side spans 186 m (NJ, to the anchorage in the Palisades: OSM's line stops at the cliff edge, 165 m) and 198 m (NY);
    # 58.8 m clearance at mid-span (chart) under the lower deck, the upper deck on a 9 m truss above it; 36 m wide.
    # The upper level's two directions are averaged into one line; the lower level, under it, is then left out.
    {'name': 'George Washington Bridge', 'region': 'new-york-harbor', 'kind': 'suspension', 'color': 0x9aa3a8, 'axis': 'lon', 'w': 36, 'depth': 9,
     'ways': [[8028082, 49032026, 1339765260], [49036344, 9702602]],
     'deck': [[-73.96066, None], [-73.9605, 66], [-73.95877, 67.5], [-73.95265, 69], [-73.9465, 67.5], [-73.94455, 66], [-73.9443, None]],
     'towers': [[-73.95877, 184, 'portal'], [-73.9465, 184, 'portal']],
     'cables': [[[-73.9604, 'deck'], [-73.95877, 'top'], [-73.9465, 'top'], [-73.94455, 'deck']]], 'sag_over': 2,
     'free': [[-73.9604, -73.94455]], 'span': 60,
     'blocks': [[-73.9604, 30, 50], [-73.94455, 30, 50]]},
    # ── New York's other big bridges (v1064, requested: "Please make an effort to make the main New York bridges look
    # more realistic"; they had been plain decks). Overpass was down, so each centre line is given as points (`line`)
    # from the OSM ways already in new-york-harbor.json; towers at the chart's PYLONS, clearances the chart's VERCLR,
    # the rest published figures. `cable_r`: the main cables drawn as tubes (m), not hairlines.
    # Manhattan Bridge (1909): towers 102 m above the water at the chart's piers (40.70511 and 40.70882, 447 m apart;
    # main span 448 m), side spans 221 m, double decked on a deep truss, 40.8 m clearance (chart); light blue-grey.
    {'name': 'Manhattan Bridge', 'region': 'new-york-harbor', 'kind': 'suspension', 'color': 0x8196a8, 'axis': 'lat', 'w': 37, 'depth': 8, 'cable_r': 0.6,
     'line': [[-73.98727, 40.7010], [-73.994933, 40.71473]],
     'deck': [[40.7012, None], [40.70327, 46], [40.70511, 48], [40.70697, 49.5], [40.70882, 48], [40.71066, 46], [40.7146, None]],
     'towers': [[40.70511, 102, 'portal'], [40.70882, 102, 'portal']],
     'cables': [[[40.70327, 'deck'], [40.70511, 'top'], [40.70882, 'top'], [40.71066, 'deck']]], 'sag_over': 2,
     'free': [[40.70511, 40.70882]], 'span': 60,
     'blocks': [[40.70327, 40, 50], [40.71066, 40, 50]]},
    # Williamsburg Bridge (1903): steel lattice towers 102 m at the chart's piers (-73.96944 and -73.9748, 487 m
    # apart; main span 488 m); the side spans on steel trestles, not hung, the cables carried on over them to the
    # anchorages; a 12 m stiffening truss; 40.5 m clearance (chart).
    {'name': 'Williamsburg Bridge', 'region': 'new-york-harbor', 'kind': 'suspension', 'color': 0x8e8f8c, 'axis': 'lon', 'w': 36, 'depth': 10, 'cable_r': 0.6,
     'line': [[-73.964613, 40.711414], [-73.978795, 40.71572]],
     'deck': [[-73.96475, None], [-73.96729, 47], [-73.96944, 50], [-73.97212, 51.5], [-73.9748, 50], [-73.97695, 47], [-73.97865, None]],
     'towers': [[-73.96944, 102, 'portal'], [-73.9748, 102, 'portal']],
     'cables': [[[-73.96729, 'deck'], [-73.96944, 'top'], [-73.9748, 'top'], [-73.97695, 'deck']]], 'sag_over': 3,
     'free': [[-73.96944, -73.9748]], 'span': 45,
     'truss': [[-73.96944, -73.9748, 4, 0]],
     'blocks': [[-73.96729, 40, 50], [-73.97695, 40, 50]]},
    # Queensboro Bridge (1909): a cantilever, through trusses over the deck, deep over the four piers (Manhattan's
    # shore, two on Roosevelt Island, Queens's shore) and shallow mid-channel, their finials ~107 m up; the channel
    # spans 360 m (west, 39.9 m clearance) and 300 m (east, 40.5 m), the island span 192 m (piers from the chart's
    # channel spans); grey.
    {'name': 'Queensboro Bridge', 'region': 'new-york-harbor', 'kind': 'truss', 'color': 0x8d8b83, 'axis': 'lon', 'w': 30, 'depth': 6,
     'line': [[-73.948878, 40.754505], [-73.960551, 40.759574]],
     'deck': [[-73.94905, None], [-73.94985, 44], [-73.95004, 45], [-73.95159, 46], [-73.95313, 45], [-73.95511, 45], [-73.95697, 46], [-73.95883, 45], [-73.9603, 44], [-73.9604, None]],
     'towers': [[-73.95004, 92, 'portal'], [-73.95313, 92, 'portal'], [-73.95511, 92, 'portal'], [-73.95883, 92, 'portal']],
     'truss': [[-73.9493, -73.95985, [[-73.9493, 6], [-73.95004, 32], [-73.95159, 7], [-73.95313, 32], [-73.95412, 22], [-73.95511, 32], [-73.95697, 7], [-73.95883, 32], [-73.95985, 6]], 0]],
     'span': 55},
    # Robert F. Kennedy (Triborough) Bridge, its suspension span over Hell Gate between Astoria and Wards Island
    # (1936): towers 96 m, main span 421 m (centred on the chart's span, 42 m clearance), side spans 213 m.
    {'name': 'Robert F. Kennedy Bridge (suspension span)', 'short': 'Robert F. Kennedy Bridge', 'region': 'new-york-harbor', 'kind': 'suspension', 'color': 0x8a958d, 'axis': 'lat', 'w': 30, 'depth': 5, 'cable_r': 0.5,
     'line': [[-73.92285, 40.7745], [-73.93047, 40.7845]],
     'deck': [[40.7746, None], [40.77655, 44], [40.77805, 46], [40.77969, 47.5], [40.78133, 46], [40.7827, 44], [40.7844, None]],
     'towers': [[40.77805, 96, 'portal'], [40.78133, 96, 'portal']],
     'cables': [[[40.77655, 'deck'], [40.77805, 'top'], [40.78133, 'top'], [40.7827, 'deck']]], 'sag_over': 2,
     'free': [[40.77655, 40.7827]], 'span': 50,
     'blocks': [[40.77655, 30, 40], [40.7827, 30, 40]]},
    # Hell Gate Bridge (1917): a steel through arch, 298 m, its crown 93 m above the water, between granite towers
    # 76 m high; the railway 40.8 m clear (chart); painted Hell Gate red.
    {'name': 'Hell Gate Bridge', 'region': 'new-york-harbor', 'kind': 'arch', 'color': 0x8c3a31, 'axis': 'lon', 'w': 20, 'depth': 3,
     'line': [[-73.92075, 40.78153], [-73.92330, 40.78344]],
     'deck': [[-73.92075, 44], [-73.92330, 44]],
     'towers': [[-73.92087, 76, 'gothic'], [-73.92316, 76, 'gothic']],
     'arch': [[-73.92095, -73.92308, 30, 93, 2.2], [-73.92095, -73.92308, 10, 72, 1.6]], 'free': [[-73.92075, -73.9233]], 'span': 60},
    # Bayonne Bridge (1931): a steel through arch, 504 m between its abutments, the crown 81 m above them; the roadway
    # raised inside it in 2017 to 65.5 m clear (chart); grey.
    {'name': 'Bayonne Bridge', 'region': 'new-york-harbor', 'kind': 'arch', 'color': 0x8f989c, 'axis': 'lat', 'w': 26, 'depth': 3,
     'line': [[-74.14448, 40.6365], [-74.13999, 40.6475]],
     'deck': [[40.6366, None], [40.6385, 60], [40.6400, 64], [40.64199, 69.5], [40.6440, 64], [40.6458, 60], [40.6474, None]],
     'arch': [[40.63985, 40.64413, 8, 84, 2.6], [40.63985, 40.64413, 2, 70, 2.0]], 'free': [[40.63985, 40.64413]], 'span': 50},
    # Bronx-Whitestone Bridge (1939): towers 115 m at the chart's piers (40.79918 and 40.80484, 699 m apart; main
    # span 701 m), side spans 224 m, a shallow stiffened deck, 39.6 m clearance (chart).
    {'name': 'Bronx-Whitestone Bridge', 'region': 'new-york-harbor', 'kind': 'suspension', 'color': 0x8f979c, 'axis': 'lat', 'w': 23, 'depth': 4, 'cable_r': 0.55,
     'line': [[-73.824987, 40.794804], [-73.835938, 40.811874]],
     'deck': [[40.7949, None], [40.79735, 42], [40.79918, 44], [40.80201, 45.5], [40.80484, 44], [40.80667, 42], [40.8117, None]],
     'towers': [[40.79918, 115, 'portal'], [40.80484, 115, 'portal']],
     'cables': [[[40.79735, 'deck'], [40.79918, 'top'], [40.80484, 'top'], [40.80667, 'deck']]], 'sag_over': 2,
     'free': [[40.79735, 40.80667]], 'span': 55,
     'blocks': [[40.79735, 35, 40], [40.80667, 35, 40]]},
    # Throgs Neck Bridge (1961): towers 109 m at the chart's piers (40.79781 and 40.80277, 551 m apart; main span
    # 549 m), side spans 169 m, a 6.7 m stiffening truss, 42 m clearance (chart); the Bronx viaduct curving away.
    {'name': 'Throgs Neck Bridge', 'region': 'new-york-harbor', 'kind': 'suspension', 'color': 0x8a979f, 'axis': 'lat', 'w': 31, 'depth': 7, 'cable_r': 0.55,
     'line': [[-73.792923, 40.791249], [-73.793539, 40.799869], [-73.793557, 40.802117], [-73.793575, 40.804366], [-73.793593, 40.806492], [-73.793619, 40.808739], [-73.793728, 40.810713], [-73.794312, 40.812484], [-73.795398, 40.814117], [-73.7969, 40.815511], [-73.798312, 40.816403]],
     'deck': [[40.7914, None], [40.79629, 45], [40.79781, 47], [40.80029, 48.5], [40.80277, 47], [40.80429, 45], [40.8163, None]],
     'towers': [[40.79781, 109, 'portal'], [40.80277, 109, 'portal']],
     'cables': [[[40.79629, 'deck'], [40.79781, 'top'], [40.80277, 'top'], [40.80429, 'deck']]], 'sag_over': 2,
     'free': [[40.79629, 40.80429]], 'span': 50,
     'blocks': [[40.79629, 30, 40], [40.80429, 30, 40]]},
    # Golden Gate (1937): towers 227 m above the water (chart PYLONS HEIGHT 225.6), main span 1,280 m between them
    # (37.8140 and 37.8255, the chart's south pier and the OSM way's break at Lime Point), side spans to the
    # anchorages (37.8110, 37.8286); road 67 m above high water at mid-span (chart VERCLR 70.5) on a 7.6 m truss.
    {'name': 'Golden Gate Bridge', 'kind': 'suspension', 'color': GG_ORANGE, 'axis': 'lat', 'w': 27, 'depth': 7.6,
     'ways': [[595194543, 1560010146], [537838948, 1560010147]],
     'deck': [[37.8085, None], [37.8100, 66], [37.8110, 67], [37.8140, 70], [37.81975, 76], [37.8255, 70], [37.8286, 69], [37.8300, None]],
     'towers': [[37.8140, 227, 'portal'], [37.8255, 227, 'portal']],
     'cables': [[[37.8110, 'deck'], [37.8140, 'top'], [37.8255, 'top'], [37.8286, 'deck']]], 'sag_over': 1.5,
     'free': [[37.8110, 37.8286]], 'span': 80,
     'blocks': [[37.8110, 30, 40], [37.8286, 30, 40]]},
    # Bay Bridge, west spans (1936): two suspension bridges end to end, sharing the central anchorage (chart pier C),
    # towers at piers A, B, D and E (158 m), double decked (a 10 m truss), 62-67 m clearance (chart).
    {'name': 'Bay Bridge (west spans)', 'short': 'Bay Bridge', 'kind': 'suspension', 'color': STEEL, 'axis': 'lon', 'w': 22, 'depth': 10,
     'ways': [[661905446]],
     'deck': [[-122.3904, None], [-122.3885, 58], [-122.3860, 70], [-122.3833, 72], [-122.3806, 74], [-122.3778, 77], [-122.3750, 74], [-122.3725, 72], [-122.3699, 70], [-122.3675, 60]],
     'towers': [[-122.3860, 158, 'portal'], [-122.3806, 158, 'portal'], [-122.3750, 158, 'portal'], [-122.3699, 158, 'portal']],
     'cables': [[[-122.3888, 'deck'], [-122.3860, 'top'], [-122.3806, 'top'], [-122.3778, 'deck']],
                [[-122.3778, 'deck'], [-122.3750, 'top'], [-122.3699, 'top'], [-122.3674, 'deck']]], 'sag_over': 1.5,
     'free': [[-122.3888, -122.3778], [-122.3778, -122.3674]], 'span': 60,
     'blocks': [[-122.3778, 50, 34], [-122.3888, 30, 30], [-122.3674, 30, 30]]},
    # Bay Bridge, east span (2013): the self-anchored suspension span from Yerba Buena (its pier W2) over the single
    # tower (chart Tower G, 160 m) to pier E2 (chart pier H), then the Skyway down to Oakland. Two decks side by side.
    *[{'name': 'Bay Bridge (east span)', 'short': 'Bay Bridge', 'kind': 'suspension', 'color': WHITE, 'axis': 'lon', 'w': 26, 'depth': 5.5,
       'ways': [ways],
       'deck': [[-122.3640, 52], [-122.3603, 49], [-122.3584, 49], [-122.3550, 46], [-122.3519, 44], [-122.3483, 41], [-122.3447, 37], [-122.3400, 30], [-122.3350, 19], [-122.3310, 9], [-122.3285, None]],
       'towers': [[-122.3584, 160, 'single']] if tower else [],
       'cables': [[[-122.3603, 'deck'], [-122.3584, 160], [-122.3550, 'deck']]], 'sag_over': 1,
       'free': [[-122.3603, -122.3550]], 'span': 160}
      for ways, tower in (([236348361], True), ([237731428], False))],
    # Richmond-San Rafael (1956): double decked, cantilever trusses over the two channels (chart: West Channel 56.3 m,
    # East Channel 41.1 m clearance), deck trusses between them (chart piers), low concrete spans west to Marin.
    {'name': 'Richmond–San Rafael Bridge', 'kind': 'truss', 'color': 0x8f9890, 'axis': 'lon', 'w': 14, 'depth': 3,
     'ways': [[24315544]],
     'deck': [[-122.4778, None], [-122.4740, 9], [-122.4560, 14], [-122.4515, 24], [-122.4484, 46], [-122.4447, 66], [-122.4410, 50], [-122.4369, 40],
              [-122.4318, 46], [-122.4270, 52], [-122.4223, 42], [-122.4183, 32], [-122.4132, 20], [-122.4098, 13], [-122.4062, None]],
     'truss': [[-122.4484, -122.4098, 0, 9],
               [-122.4500, -122.4395, [[-122.4500, 4], [-122.4484, 22], [-122.4447, 10], [-122.4410, 22], [-122.4395, 4]], 9],
               [-122.4330, -122.4210, [[-122.4330, 4], [-122.4318, 18], [-122.4270, 9], [-122.4223, 18], [-122.4210, 4]], 9]],
     'span': 90},
    # San Mateo-Hayward (1967, widened 2002): the steel high-rise over the channel (41.1 m clearance, chart; the
    # deepest water at -122.2499), the low concrete trestle across the shallows to Hayward.
    {'name': 'San Mateo–Hayward Bridge', 'kind': 'girder', 'color': CONCRETE, 'axis': 'lon', 'w': 30, 'depth': 3,
     'ways': [[42248740], [156047241]],
     'deck': [[-122.2631, None], [-122.2600, 18], [-122.2545, 40], [-122.2499, 47], [-122.2450, 40], [-122.2380, 22], [-122.2320, 9], [-122.2250, 8], [-122.1600, 8], [-122.1557, None]],
     'span': 60},
    # Dumbarton (1982): a high span over the channel (26 m clearance) on long low approaches.
    {'name': 'Dumbarton Bridge', 'kind': 'girder', 'color': CONCRETE, 'axis': 'lon', 'w': 26, 'depth': 3,
     'ways': [[42127704, 184877571], [184877572, 26972072]],
     'deck': [[-122.1300, None], [-122.1265, 8], [-122.1225, 22], [-122.1171, 32], [-122.1120, 22], [-122.1090, 9], [-122.1084, None]],
     'span': 50},
    # Carquinez: the Al Zampa Memorial Bridge (2003, westbound), a suspension bridge with concrete towers (125 m) and a
    # 728 m main span; beside it the 1958 cantilever truss (eastbound). Chart clearances 40.2 and 44.5 m.
    {'name': 'Al Zampa Memorial Bridge', 'short': 'Carquinez Bridge', 'kind': 'suspension', 'color': WHITE, 'axis': 'lat', 'w': 24, 'depth': 4,
     'ways': [[157618391, 1016085442]],
     'deck': [[38.0525, None], [38.0540, 30], [38.05622, 44], [38.0575, 46], [38.0608, 52], [38.0641, 49], [38.06594, 45]],
     'towers': [[38.0575, 125, 'portal'], [38.0641, 125, 'portal']],
     'cables': [[[38.05622, 'deck'], [38.0575, 'top'], [38.0641, 'top'], [38.06594, 'deck']]], 'sag_over': 1.5,
     'free': [[38.05622, 38.06594]], 'span': 60},
    {'name': 'Carquinez Bridge (1958)', 'short': 'Carquinez Bridge', 'kind': 'truss', 'color': STEEL, 'axis': 'lat', 'w': 20, 'depth': 3,
     'ways': [[23994277, 123741232, 1208632372]],
     'deck': [[38.0522, None], [38.0540, 30], [38.0557, 44], [38.0587, 46], [38.0607, 50], [38.0626, 50], [38.06553, 46]],
     'truss': [[38.0557, 38.06553, [[38.0557, 6], [38.0570, 34], [38.0587, 14], [38.0607, 36], [38.0626, 14], [38.0644, 34], [38.06553, 6]], 6]],
     'span': 70},
    # Benicia-Martinez: the 2007 concrete span (northbound; 46.6 m clearance), the 1962 steel deck truss (southbound;
    # 41.1 m), and the Union Pacific's 1930 rail bridge, its lift span (21.3 m down, 41.1 m up) near the south end.
    {'name': 'Benicia–Martinez Bridge', 'kind': 'girder', 'color': CONCRETE, 'axis': 'lat', 'w': 26, 'depth': 6,
     'ways': [[4968908, 1517469365, 8703049]],
     'deck': [[38.0317, None], [38.0335, 28], [38.0360, 46], [38.0394, 54], [38.0440, 50], [38.0480, 34], [38.0500, None]],
     'span': 160},
    {'name': 'Benicia–Martinez Bridge (1962)', 'short': 'Benicia–Martinez Bridge', 'kind': 'truss', 'color': OLD_STEEL, 'axis': 'lat', 'w': 18, 'depth': 3,
     'ways': [[52000448]],
     'deck': [[38.0331, None], [38.0345, 30], [38.0365, 44], [38.0384, 50], [38.0440, 48], [38.0477, None]],
     'truss': [[38.0345, 38.0460, 0, 10]],
     'span': 100},
    {'name': 'Benicia–Martinez rail bridge', 'short': 'Benicia–Martinez Bridge', 'kind': 'truss', 'color': 0x6c6456, 'axis': 'lat', 'w': 10, 'depth': 2,
     'ways': [[1011569355, 109811815], [35470931, 1011569354]],
     'deck': [[38.0350, None], [38.0372, 20], [38.0380, 24], [38.0470, 24], [38.0482, None]],
     'truss': [[38.0375, 38.0478, 10, 0]],
     'towers': [[38.03815, 66, 'lift'], [38.03905, 66, 'lift']],
     'span': 100},
    # Highway 37 over the Napa River at Vallejo (30.4 m clearance, chart)
    {'name': 'Napa River Bridge', 'kind': 'girder', 'color': CONCRETE, 'axis': 'lon', 'w': 24, 'depth': 3,
     'ways': [[669677237, 946439708], [751738167]],
     'deck': [[-122.2858, None], [-122.2835, 20], [-122.2798, 36], [-122.2775, 24], [-122.2756, None]],
     'span': 60},
]


def overpass(q):
    for k in range(6):
        for url in OVERPASS:
            try:
                req = urllib.request.Request(url, urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': 'AudioChart-build/1.0'})
                with urllib.request.urlopen(req, timeout=240) as r:
                    return json.load(r)
            except Exception as e:
                print('overpass:', url, e)
        time.sleep(30 * (k + 1))
    sys.exit('Overpass unreachable')


def mxy(lat):
    return 111320 * math.cos(math.radians(lat)), 111120


def dist(a, b):
    mx, my = mxy((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * mx, (a[1] - b[1]) * my)


def chain(ways, ids):
    pts = []
    for i in ids:
        g = [(p['lon'], p['lat']) for p in ways[i]['geometry']]
        if pts:
            if dist(pts[-1], g[0]) > dist(pts[-1], g[-1]):
                g = g[::-1]
            if dist(pts[-1], g[0]) < 2:
                g = g[1:]
        elif len(ids) > 1:   # the first way: point it at the second
            nxt = [(p['lon'], p['lat']) for p in ways[ids[1]]['geometry']]
            if min(dist(g[0], nxt[0]), dist(g[0], nxt[-1])) < min(dist(g[-1], nxt[0]), dist(g[-1], nxt[-1])):
                g = g[::-1]
        pts += g
    return pts


def densify(pts, step):
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        n = max(1, math.ceil(dist(a, b) / step))
        out += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(1, n + 1)]
    return out


def nearest_on(pts, p):
    best = None
    for a, b in zip(pts, pts[1:]):
        mx, my = mxy(p[1])
        ax, ay, bx, by = (a[0] - p[0]) * mx, (a[1] - p[1]) * my, (b[0] - p[0]) * mx, (b[1] - p[1]) * my
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, -(ax * dx + ay * dy) / ((dx * dx + dy * dy) or 1)))
        d = math.hypot(ax + t * dx, ay + t * dy)
        if best is None or d < best[0]:
            best = (d, (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return best[1]


def centre(a, b, step):
    A = densify(a, step)
    if b is None:
        return A
    if dist(A[0], b[0]) + dist(A[-1], b[-1]) > dist(A[0], b[-1]) + dist(A[-1], b[0]):
        b = b[::-1]
    return [((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) for p in A for q in [nearest_on(b, p)]]


def stations(pts):
    s = [0.0]
    for a, b in zip(pts, pts[1:]):
        s.append(s[-1] + dist(a, b))
    return s


def at_coord(pts, S, axis, c):
    """The station (and point) where the line crosses coordinate c (lon or lat), else the nearest end."""
    k = 0 if axis == 'lon' else 1
    for i in range(len(pts) - 1):
        a, b = pts[i][k], pts[i + 1][k]
        if (a - c) * (b - c) <= 0 and a != b:
            t = (c - a) / (b - a)
            return S[i] + (S[i + 1] - S[i]) * t, (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t)
    i = 0 if abs(pts[0][k] - c) < abs(pts[-1][k] - c) else len(pts) - 1
    return S[i], pts[i]


def interp(knots, s):
    """knots: [(station, value | None)] sorted; the value at s, None toward a None knot (the ground: bridges3d.js
    ramps the deck from the ground at the line's end to the first height)."""
    if s <= knots[0][0]:
        return knots[0][1]
    for (s0, v0), (s1, v1) in zip(knots, knots[1:]):
        if s <= s1:
            if v0 is None or v1 is None:
                return None
            return v0 + (v1 - v0) * (s - s0) / ((s1 - s0) or 1)
    return knots[-1][1]


def az_at(pts, i):
    a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
    mx, my = mxy(a[1])
    return math.degrees(math.atan2((b[0] - a[0]) * mx, (b[1] - a[1]) * my)) % 360


def offset(p, az, d):
    mx, my = mxy(p[1])
    r = math.radians(az + 90)
    return (p[0] + math.sin(r) * d / mx, p[1] + math.cos(r) * d / my)


def r5(x):
    return round(x, 6)


def build_spec(sp, ways):
    axis = sp['axis']
    # (v1064: or `line`, the centre line itself as [lon, lat] points, for a straight bridge, when Overpass can't be had)
    lines = [chain(ways, ids) for ids in sp['ways']] if 'ways' in sp else [[tuple(p) for p in sp['line']]]
    pts = centre(lines[0], lines[1] if len(lines) > 1 else None, 15)
    S = stations(pts)
    dk = sorted(((at_coord(pts, S, axis, c)[0], h) for c, h in sp["deck"]), key=lambda k: k[0])
    # the line runs only as far as the first and last knots' ends (the bridge's own ways reach onto the land)
    lo, hi = dk[0][0], dk[-1][0]
    keep = [i for i in range(len(pts)) if lo - 1 <= S[i] <= hi + 1]
    pts, S = [pts[i] for i in keep], [S[i] for i in keep]
    H = [interp(dk, s) for s in S]
    deck_at = lambda s: interp(dk, s)
    B = {'name': sp['name'], 'short': sp.get('short', sp['name']), 'kind': sp['kind'], 'color': sp['color'], 'w': sp['w'], 'depth': sp['depth'],
         'pts': [[r5(p[0]), r5(p[1]), None if h is None else round(h, 1)] for p, h in zip(pts, H)]}
    # piers: every `span` m, not under a suspended span
    free = [sorted(at_coord(pts, S, axis, c)[0] for c in f) for f in sp.get('free', [])]
    piers, s = [], sp['span'] / 2
    while s < S[-1]:
        if not any(a - 5 < s < b + 5 for a, b in free):
            i = min(range(len(S)), key=lambda j: abs(S[j] - s))
            if H[i] is not None:
                piers.append([r5(pts[i][0]), r5(pts[i][1]), round(H[i] - sp['depth'] - (0 if sp['kind'] != 'truss' else 0), 1), round(az_at(pts, i))])
        s += sp['span']
    B['piers'] = piers
    towers = []
    for c, top, kind in sp.get('towers', []):
        st, p = at_coord(pts, S, axis, c)
        i = min(range(len(S)), key=lambda j: abs(S[j] - st))
        towers.append({'lon': r5(p[0]), 'lat': r5(p[1]), 'top': top, 'az': round(az_at(pts, i)), 'kind': kind, 'w': sp['w'] + 4, 'deck': round(deck_at(st) or 0, 1)})
    B['towers'] = towers
    # cables: through the given points (a tower's top, or the deck), sagging between towers to just over the deck
    cables = []
    for spec in sp.get('cables', []):
        P = []
        for c, what in spec:
            st, p = at_coord(pts, S, axis, c)
            top = next((t['top'] for t in towers if abs(at_coord(pts, S, axis, c)[0] - st) < 1 and dist((t['lon'], t['lat']), p) < 30), None)
            P.append((st, (deck_at(st) or 0) + 1 if what == 'deck' else what if isinstance(what, (int, float)) else top))
        for side in (-1, 1):
            line = []
            for (s0, h0), (s1, h1) in zip(P, P[1:]):
                n = max(2, round((s1 - s0) / 15))
                both_tops = h0 > (deck_at(s0) or 0) + 10 and h1 > (deck_at(s1) or 0) + 10
                if both_tops:   # a main span: a parabola, its lowest just over the deck
                    sm = (s0 + s1) / 2
                    low = (deck_at(sm) or 0) + sp.get('sag_over', 1.5)
                    sag = (h0 + h1) / 2 - low
                else:           # a side span: nearly straight, sagging a little
                    sag = 0.035 * (s1 - s0)
                for k in range(0 if not line else 1, n + 1):
                    t = k / n
                    s = s0 + (s1 - s0) * t
                    h = h0 + (h1 - h0) * t - 4 * sag * t * (1 - t)
                    dh = deck_at(s) or 0
                    h = max(h, dh + 1)
                    i = min(range(len(S)), key=lambda j: abs(S[j] - s))
                    p = offset(pts[i], az_at(pts, i), side * sp['w'] / 2)
                    line.append([r5(p[0]), r5(p[1]), round(h, 1), round(dh, 1)])
            cables.append(line)
    B['cables'] = cables
    trusses = []
    for c0, c1, above, below in sp.get('truss', []):
        a, b = sorted(at_coord(pts, S, axis, c)[0] for c in (c0, c1))
        idx = [i for i in range(len(S)) if a <= S[i] <= b]
        if not idx:
            continue
        if isinstance(above, list):
            ak = sorted(((at_coord(pts, S, axis, c)[0], v) for c, v in above), key=lambda k: k[0])
            ab = [round(interp(ak, S[i]), 1) for i in idx]
        else:
            ab = [above] * len(idx)
        trusses.append({'i0': idx[0], 'i1': idx[-1], 'above': ab, 'below': below})
    B['truss'] = trusses
    blocks = []
    for c, ln, w in sp.get('blocks', []):
        st, p = at_coord(pts, S, axis, c)
        i = min(range(len(S)), key=lambda j: abs(S[j] - st))
        blocks.append({'lon': r5(p[0]), 'lat': r5(p[1]), 'az': round(az_at(pts, i)), 'len': ln, 'w': w, 'top': round((deck_at(st) or 0) + 2, 1)})
    B['blocks'] = blocks
    # arches (v1064): ribs each side, a parabola between their springings c0..c1 (on the axis) from `spring` to
    # `crown` m above the water, `r` m thick; bridges3d.js draws them as tubes, the hangers down to the deck above
    # it and the posts up to it below
    arches = []
    for c0, c1, spring, crown, r in sp.get('arch', []):
        a0, a1 = sorted(at_coord(pts, S, axis, c)[0] for c in (c0, c1))
        for side in (-1, 1):
            rib = []
            for k in range(41):
                t = k / 40; st = a0 + (a1 - a0) * t
                i = min(range(len(S)), key=lambda j: abs(S[j] - st))
                p = offset(pts[i], az_at(pts, i), side * sp['w'] / 2)
                rib.append([r5(p[0]), r5(p[1]), round(spring + (crown - spring) * (1 - (2 * t - 1) ** 2), 1), round(deck_at(st) or 0, 1)])
            arches.append({'r': r, 'pts': rib})
    if arches: B['arches'] = arches
    if sp.get('cable_r'): B['cable_r'] = sp['cable_r']
    return B


def chart_bridges(chart_dir):
    out = []
    for f in sorted(glob.glob(os.path.join(chart_dir, 'US*', '*.000'))):
        ds = ogr.Open(f)
        L = ds.GetLayerByName('BRIDGE')
        if not L:
            continue
        for ft in L:
            g = shape(json.loads(ft.GetGeometryRef().ExportToJson()))
            cat = ft.GetField('CATBRG') or []
            out.append({'g': g, 'name': ft.GetField('OBJNAM'), 'cat': [int(c) for c in cat],
                        'clr': ft.GetField('VERCLR'), 'closed': ft.GetField('VERCCL'), 'open': ft.GetField('VERCOP')})
    return out


def main():
    rid = sys.argv[1] if len(sys.argv) > 1 else 'sf-bay'
    R = REGIONS[rid]
    s, w, n, e = R['bbox']
    osm_file = next((a[4:] for a in sys.argv[2:] if a.startswith('OSM=')), None)
    if osm_file:
        J = json.load(open(osm_file))
    else:
        J = overpass(f'[out:json][timeout:180];(way["bridge"]["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]({s},{w},{n},{e});'
                     f'way["bridge"]["railway"~"^(rail|disused|abandoned)$"]({s},{w},{n},{e}););out tags geom;')
    ways = {x['id']: x for x in J['elements'] if x['type'] == 'way'}
    used = set()
    bridges = []
    for sp in SPECS:
        if sp.get('region', 'sf-bay') != rid:
            continue   # (the big bridges described so far are all San Francisco's)
        used |= {i for ids in sp.get('ways', []) for i in ids}
        bridges.append(build_spec(sp, ways))
        print(f"{sp['name']}: {len(bridges[-1]['pts'])} points, {len(bridges[-1]['piers'])} piers, {len(bridges[-1]['towers'])} towers")
    # the rest: a plain deck on piers, where OSM's bridge is over the chart's water
    land = [shape(f['geometry']) for f in json.load(open(os.path.join(ROOT, f'www/data/regions/{rid}/land.geojson')))['features']]
    tree = STRtree(land)
    on_land = lambda lon, lat: any(land[i].contains(Point(lon, lat)) for i in tree.query(Point(lon, lat)))
    charted = chart_bridges(os.path.expanduser(R['charts']))
    ctree = STRtree([c['g'] for c in charted])
    big = [b for b in bridges]
    for x in ways.values():
        if x['id'] in used:
            continue
        g = [(p['lon'], p['lat']) for p in x['geometry']]
        L = sum(dist(a, b) for a, b in zip(g, g[1:]))
        if L < 40:
            continue
        D = densify(g, 10)
        wet = sum(not on_land(*p) for p in D[1:-1]) / max(1, len(D) - 2)
        if {x['tags'].get('name'), x['tags'].get('bridge:name')} & R.get('wet', set()):
            wet = 1.0
        if wet < 0.3:
            continue
        mid = D[len(D) // 2]
        if any(min(dist(mid, (q[0], q[1])) for q in b['pts']) < 60 for b in big):
            continue   # (a ramp of one of the big ones)
        line = LineString(D)
        hits = [charted[i] for i in ctree.query(line.buffer(0.0003)) if charted[i]['g'].distance(line) < 0.0003]
        clr = max([c['closed'] or c['clr'] or 0 for c in hits] or [0])
        top = (clr + 1.5) if clr else 4.5
        rail = 'railway' in x['tags']
        name = x['tags'].get('bridge:name') or next((c['name'] for c in hits if c['name']), None) or x['tags'].get('name') or ('Rail bridge' if rail else 'Bridge')
        S = stations(D)
        ramp = min(25, L / 4)
        H = [None if s < 0.5 or s > S[-1] - 0.5 else round(min(top, 1.5 + (top - 1.5) * min(s, S[-1] - s) / ramp), 1) for s in S]
        lanes = int(x['tags'].get('lanes', '2').split(';')[0]) if x['tags'].get('lanes', '2').split(';')[0].isdigit() else 2
        wd = 6 if rail else 3.6 * lanes + 3
        b = {'name': name, 'short': name, 'kind': 'girder', 'color': 0x6c6456 if rail else CONCRETE, 'w': wd, 'depth': 1.6,
             'pts': [[r5(p[0]), r5(p[1]), h] for p, h in zip(D, H)], 'piers': [], 'towers': [], 'cables': [], 'truss': [], 'blocks': [], 'minor': True}
        sp = max(20, min(40, L / 4))
        k = sp / 2
        while k < S[-1] - 5:
            i = min(range(len(S)), key=lambda j: abs(S[j] - k))
            if H[i] is not None:
                b['piers'].append([r5(D[i][0]), r5(D[i][1]), round(H[i] - 1.6, 1), round(az_at(D, i))])
            k += sp
        for c in hits:   # a lift bridge: a tower at each end of its lift span
            if 4 in c['cat'] and c['open'] and not c.get('towered'):
                ends = sorted({nearest_on(D, (q[0], q[1])) for q in c['g'].exterior.coords} if c['g'].geom_type == 'Polygon' else [], key=lambda q: dist(q, D[0]))
                if len(ends) >= 2:
                    c['towered'] = True   # (once, though OSM has the bridge in several pieces)
                    for q in (ends[0], ends[-1]):
                        i = min(range(len(D)), key=lambda j: dist(D[j], q))
                        b['towers'].append({'lon': r5(q[0]), 'lat': r5(q[1]), 'top': round(c['open'] + 8, 1), 'az': round(az_at(D, i)), 'kind': 'lift', 'w': wd + 3, 'deck': top})
        bridges.append(b)
        print(f"  + {name}: {round(L)} m, {round(wet * 100)}% over water, deck {top} m{', lift' if b['towers'] else ''}")
    out = os.path.join(ROOT, f'www/data/bridges/{rid}.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump({'made': time.strftime('%Y-%m-%d'), 'credit': 'Bridges © OpenStreetMap contributors, NOAA charts', 'bridges': bridges}, open(out, 'w'), separators=(',', ':'))
    print(out, os.path.getsize(out) // 1024, 'KB,', len(bridges), 'bridges')


main()
