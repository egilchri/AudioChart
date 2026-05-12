"""
Server-side chart database.
Parses all available ENC charts into SQLite for fast spatial queries.
Replaces the static GeoJSON files with a dynamic position-based API.
"""
import asyncio
import json
import math
import os
import sqlite3
import sys
import time

# Add preprocess dir to path for s57_codes
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PREPROCESS_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '../preprocess'))
sys.path.insert(0, PREPROCESS_DIR)

from s57_codes import (
    DEPTH_LAYER, HAZARD_LAYERS, NAMED_PLACE_LAYERS, NAVAID_LAYERS,
    OBJTYPE_LABEL, SHALLOW_DEPTH_THRESHOLD_M,
)

ENC_BASE = os.path.expanduser('~/Documents/Charts/ENC/US_ME')
DB_PATH = os.path.join(SCRIPT_DIR, 'charts.db')

# Default query radius in nautical miles
DEFAULT_RADIUS_NM = 20.0

import threading
_local = threading.local()   # per-thread connection


# ── Schema ────────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS features (
    id       INTEGER PRIMARY KEY,
    category TEXT NOT NULL,   -- 'hazard', 'place', 'navaid'
    objtype  TEXT NOT NULL,
    label    TEXT NOT NULL,
    lat      REAL NOT NULL,
    lon      REAL NOT NULL,
    name     TEXT,
    name_lower TEXT,
    props    TEXT NOT NULL,   -- JSON blob for extra attributes
    chart_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_features_latlon ON features(lat, lon);
CREATE INDEX IF NOT EXISTS idx_features_category ON features(category);
CREATE INDEX IF NOT EXISTS idx_features_name ON features(name_lower);

CREATE TABLE IF NOT EXISTS magvar (
    id       INTEGER PRIMARY KEY,
    lat      REAL NOT NULL,
    lon      REAL NOT NULL,
    valmag   REAL NOT NULL,
    valacm   REAL,
    ryrmgv   TEXT,
    chart_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_magvar_latlon ON magvar(lat, lon);

CREATE TABLE IF NOT EXISTS processed_charts (
    chart_id TEXT PRIMARY KEY,
    processed_at REAL NOT NULL
);
"""


def get_db():
    """Return a per-thread SQLite connection (thread-safe, no sharing)."""
    if not hasattr(_local, 'db') or _local.db is None:
        _local.db = sqlite3.connect(DB_PATH)
        _local.db.execute('PRAGMA journal_mode=WAL')
        _local.db.execute('PRAGMA synchronous=NORMAL')
        _local.db.executescript(SCHEMA)
        _local.db.commit()
    return _local.db


# ── Geometry helpers ───────────────────────────────────────────────────────────

def centroid(geom):
    """Return (lat, lon) centroid of any GeoJSON geometry dict."""
    t = geom['type']
    coords = geom['coordinates']
    if t == 'Point':
        return coords[1], coords[0]
    # Flatten to list of [lon, lat] pairs
    def flatten(c):
        if isinstance(c[0], (int, float)):
            yield c
        else:
            for sub in c:
                yield from flatten(sub)
    pts = list(flatten(coords))
    lat = sum(p[1] for p in pts) / len(pts)
    lon = sum(p[0] for p in pts) / len(pts)
    return lat, lon


def haversine_nm(lat1, lon1, lat2, lon2):
    R = 3440.065
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


# ── ENC parsing ────────────────────────────────────────────────────────────────

def _parse_chart(enc_path, chart_id, db):
    try:
        import fiona
    except ImportError:
        print('[chartdb] fiona not installed — cannot parse ENC')
        return 0

    rows_hazard, rows_place, rows_navaid, rows_magvar = [], [], [], []

    try:
        layers = set(fiona.listlayers(enc_path))
    except Exception:
        return 0

    def _ctr(geom):
        try:
            return centroid(geom)
        except Exception:
            return None

    # Hazards
    for layer in HAZARD_LAYERS:
        if layer not in layers:
            continue
        with fiona.open(enc_path, layer=layer) as src:
            for feat in src:
                geom = feat.get('geometry')
                if not geom:
                    continue
                p = feat['properties']
                if p.get('WATLEV') == 3:
                    continue
                pos = _ctr(geom)
                if not pos:
                    continue
                props = {'valsou': p.get('VALSOU'), 'watlev': p.get('WATLEV')}
                name = p.get('OBJNAM')
                rows_hazard.append((
                    'hazard', layer, OBJTYPE_LABEL.get(layer, layer),
                    pos[0], pos[1], name, name.lower() if name else None,
                    json.dumps(props), chart_id
                ))

    # Shallow depth areas
    if DEPTH_LAYER in layers:
        with fiona.open(enc_path, layer=DEPTH_LAYER) as src:
            for feat in src:
                geom = feat.get('geometry')
                if not geom:
                    continue
                p = feat['properties']
                drval2 = p.get('DRVAL2')
                if drval2 is None or drval2 > SHALLOW_DEPTH_THRESHOLD_M:
                    continue
                pos = _ctr(geom)
                if not pos:
                    continue
                drval1 = p.get('DRVAL1')
                depth_label = f'{drval1:.1f}-{drval2:.1f}m' if drval1 is not None else f'<{drval2:.1f}m'
                props = {'valsou': drval2, 'depth_label': depth_label}
                rows_hazard.append((
                    'hazard', DEPTH_LAYER, OBJTYPE_LABEL[DEPTH_LAYER],
                    pos[0], pos[1], None, None,
                    json.dumps(props), chart_id
                ))

    # Named places
    for layer in NAMED_PLACE_LAYERS:
        if layer not in layers:
            continue
        with fiona.open(enc_path, layer=layer) as src:
            for feat in src:
                geom = feat.get('geometry')
                if not geom:
                    continue
                name = feat['properties'].get('OBJNAM')
                if not name or len(name.strip()) <= 2 and name.strip().isalpha():
                    continue
                name = name.strip()
                pos = _ctr(geom)
                if not pos:
                    continue
                rows_place.append((
                    'place', layer, OBJTYPE_LABEL.get(layer, layer),
                    pos[0], pos[1], name, name.lower(),
                    '{}', chart_id
                ))

    # Navaids
    for layer in NAVAID_LAYERS:
        if layer not in layers:
            continue
        with fiona.open(enc_path, layer=layer) as src:
            for feat in src:
                geom = feat.get('geometry')
                if not geom:
                    continue
                p = feat['properties']
                name = p.get('OBJNAM')
                colours = p.get('COLOUR')
                from s57_codes import COLOUR_LABEL
                colour_str = None
                if colours:
                    colour_str = '/'.join(
                        COLOUR_LABEL.get(int(c), str(c))
                        for c in (colours if isinstance(colours, list) else [colours])
                    )
                pos = _ctr(geom)
                if not pos:
                    continue
                props = {'colour': colour_str}
                rows_navaid.append((
                    'navaid', layer, OBJTYPE_LABEL.get(layer, 'navaid'),
                    pos[0], pos[1], name, name.lower() if name else None,
                    json.dumps(props), chart_id
                ))

    # Magnetic variation
    if 'MAGVAR' in layers:
        with fiona.open(enc_path, layer='MAGVAR') as src:
            for feat in src:
                geom = feat.get('geometry')
                if not geom:
                    continue
                p = feat['properties']
                valmag = p.get('VALMAG')
                if valmag is None:
                    continue
                pos = _ctr(geom)
                if not pos:
                    continue
                rows_magvar.append((
                    pos[0], pos[1], float(valmag),
                    p.get('VALACM'), p.get('RYRMGV'), chart_id
                ))

    # Batch insert under lock (WAL allows concurrent reads but serialises writes)
    INS = ('INSERT OR IGNORE INTO features '
           '(category,objtype,label,lat,lon,name,name_lower,props,chart_id) '
           'VALUES (?,?,?,?,?,?,?,?,?)')
    db.executemany(INS, rows_hazard + rows_place + rows_navaid)
    if rows_magvar:
        db.executemany(
            'INSERT OR IGNORE INTO magvar (lat,lon,valmag,valacm,ryrmgv,chart_id) VALUES (?,?,?,?,?,?)',
            rows_magvar
        )
    db.execute('INSERT OR REPLACE INTO processed_charts VALUES (?,?)', (chart_id, time.time()))
    db.commit()

    return len(rows_hazard) + len(rows_place) + len(rows_navaid)


# ── Public API ─────────────────────────────────────────────────────────────────

def is_chart_processed(chart_id):
    db = get_db()
    row = db.execute('SELECT 1 FROM processed_charts WHERE chart_id=?', (chart_id,)).fetchone()
    return row is not None


def process_chart_file(enc_path):
    chart_id = os.path.splitext(os.path.basename(enc_path))[0]
    if is_chart_processed(chart_id):
        return 0, chart_id
    db = get_db()
    n = _parse_chart(enc_path, chart_id, db)
    return n, chart_id


def find_enc_files():
    """Return all .000 ENC files in ENC_BASE."""
    result = []
    for root, _, files in os.walk(ENC_BASE):
        for f in files:
            if f.endswith('.000'):
                result.append(os.path.join(root, f))
    return sorted(result)


def get_nearby(lat, lon, radius_nm=DEFAULT_RADIUS_NM):
    """
    Return features within radius_nm nautical miles of (lat, lon).
    Returns dict with 'hazards', 'places', 'navaids', 'magvar'.
    """
    db = get_db()

    # Rough bounding box filter (degrees) then exact haversine
    deg_lat = radius_nm / 60.0
    deg_lon = radius_nm / (60.0 * math.cos(math.radians(lat)))

    rows = db.execute('''
        SELECT category, objtype, label, lat, lon, name, props
        FROM features
        WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
    ''', (lat - deg_lat, lat + deg_lat, lon - deg_lon, lon + deg_lon)).fetchall()

    hazards, places, navaids = [], [], []
    for cat, objtype, label, flat, flon, name, props_json in rows:
        dist = haversine_nm(lat, lon, flat, flon)
        if dist > radius_nm:
            continue
        props = json.loads(props_json) if props_json else {}
        props.update({'objtype': objtype, 'label': label})
        if name:
            props['name'] = name
            props['name_lower'] = name.lower()
        feat = {'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [flon, flat]},
                'properties': props}
        if cat == 'hazard':
            hazards.append(feat)
        elif cat == 'place':
            places.append(feat)
        else:
            navaids.append(feat)

    # Nearest MAGVAR
    mv_rows = db.execute('''
        SELECT valmag, valacm, ryrmgv
        FROM magvar
        WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
        LIMIT 5
    ''', (lat - deg_lat, lat + deg_lat, lon - deg_lon, lon + deg_lon)).fetchall()

    magvar_val = None
    if mv_rows:
        # Average nearby values, apply annual change to current year
        import datetime
        current_year = datetime.datetime.now().year
        vals = []
        for valmag, valacm, ryrmgv in mv_rows:
            ref_year = int(ryrmgv) if ryrmgv and ryrmgv.isdigit() else current_year
            # VALACM is in minutes/year; convert to degrees
            annual_deg = (float(valacm) / 60.0) if valacm else 0
            adjusted = valmag + annual_deg * (current_year - ref_year)
            vals.append(adjusted)
        magvar_val = sum(vals) / len(vals)

    return {
        'hazards': {'type': 'FeatureCollection', 'features': hazards},
        'places':  {'type': 'FeatureCollection', 'features': places},
        'navaids': {'type': 'FeatureCollection', 'features': navaids},
        'magvar':  round(magvar_val, 1) if magvar_val is not None else None,
        'count': len(hazards) + len(places) + len(navaids),
        'radius_nm': radius_nm,
    }


LABEL_RANK = {'town': 3, 'harbour': 3, 'coastal feature': 2, 'sea area': 0}

import re as _re

_DIRECTIONAL_RE = [
    (_re.compile(r'^west(?:ern)?\s+(?:end|entrance|side)\s+(?:of|to)\s+', _re.I), 270),
    (_re.compile(r'^east(?:ern)?\s+(?:end|entrance|side)\s+(?:of|to)\s+', _re.I), 90),
    (_re.compile(r'^north(?:ern)?\s+(?:end|entrance|side)\s+(?:of|to)\s+', _re.I), 0),
    (_re.compile(r'^south(?:ern)?\s+(?:end|entrance|side)\s+(?:of|to)\s+', _re.I), 180),
    (_re.compile(r'^(?:entrance|entry|mouth)\s+(?:of|to)\s+', _re.I), None),
]


def _parse_directional(query):
    """Strip 'west end of', 'eastern entrance to', etc. from a query.
    Returns (clean_name, bearing_deg_or_None)."""
    q = query.strip()
    for pat, bearing in _DIRECTIONAL_RE:
        m = pat.match(q)
        if m:
            return q[m.end():].strip(), bearing
    return q, None


def _offset_coords(lat, lon, bearing_deg, dist_nm=3.0):
    """Return (lat, lon) offset dist_nm nautical miles in bearing_deg direction."""
    d = dist_nm / 3440.065
    brg = math.radians(bearing_deg)
    lat1, lon1 = math.radians(lat), math.radians(lon)
    lat2 = math.asin(math.sin(lat1)*math.cos(d) + math.cos(lat1)*math.sin(d)*math.cos(brg))
    lon2 = lon1 + math.atan2(math.sin(brg)*math.sin(d)*math.cos(lat1),
                              math.cos(d) - math.sin(lat1)*math.sin(lat2))
    return math.degrees(lat2), math.degrees(lon2)


def _parse_disambiguated(query):
    """Split 'Crow Island, near Great Cranberry Island' → ('crow island', 'great cranberry island').
    Returns (primary, qualifier_or_None)."""
    if ',' not in query:
        return query.strip().lower(), None
    primary, qualifier = query.split(',', 1)
    qualifier = qualifier.strip().lower()
    if qualifier.startswith('near '):
        qualifier = qualifier[5:].strip()
    return primary.strip().lower(), qualifier or None


def _dist_sq(lat1, lon1, lat2, lon2):
    return (lat1 - lat2) ** 2 + (lon1 - lon2) ** 2


def find_place_by_name(query):
    """
    Search the full chart database for a named place matching query.
    Handles:
    - Directional qualifiers: 'west end of X', 'eastern entrance to X'
    - Disambiguation: 'Crow Island, Cranberry Isles'
    Returns {'lat', 'lon', 'name'} for the best match, or None.
    """
    clean, direction = _parse_directional(query)
    primary, qualifier = _parse_disambiguated(clean)

    # Resolve qualifier to coordinates for proximity selection
    qual_loc = find_place_by_name(qualifier) if qualifier else None

    db = get_db()

    # Exact match first (fast, uses index)
    rows = db.execute(
        "SELECT label, lat, lon, name FROM features WHERE name_lower = ? ORDER BY ROWID",
        (primary,)
    ).fetchall()

    result = None
    if rows:
        if qual_loc and len(rows) > 1:
            best = min(rows, key=lambda r: _dist_sq(r[1], r[2], qual_loc['lat'], qual_loc['lon']))
        else:
            best = max(rows, key=lambda r: LABEL_RANK.get(r[0], 1))
        result = {'lat': best[1], 'lon': best[2], 'name': best[3]}
    else:
        # Fuzzy fallback
        words = primary.split()
        if not words:
            return None
        like = f'%{words[0]}%'
        rows = db.execute(
            "SELECT label, lat, lon, name, name_lower FROM features WHERE name_lower LIKE ? LIMIT 200",
            (like,)
        ).fetchall()

        def score(row):
            nl = row[4]
            if nl == primary:
                return 1.0 + LABEL_RANK.get(row[0], 1) * 0.001
            if primary in nl:
                base = len(primary) / len(nl)
            elif nl in primary:
                base = len(nl) / len(primary)
            else:
                dist = sum(1 for a, b in zip(primary, nl) if a != b) + abs(len(primary) - len(nl))
                base = 1 - dist / max(len(primary), len(nl), 1)
            return base + LABEL_RANK.get(row[0], 1) * 0.001

        if not rows:
            return None
        best = max(rows, key=score)
        if score(best) < 0.5:
            return None
        result = {'lat': best[1], 'lon': best[2], 'name': best[3]}

    if result and direction is not None:
        new_lat, new_lon = _offset_coords(result['lat'], result['lon'], direction)
        return {**result, 'lat': new_lat, 'lon': new_lon}
    return result


def get_course_hazards(from_lat, from_lon, to_lat, to_lon, corridor_nm=0.25):
    """
    Return hazards within corridor_nm of the great-circle course from A to B,
    querying the full chart database (not limited to a position radius).
    Returns {'hazards': [...], 'count': N, 'course_length_nm': D}.
    """
    pad = (corridor_nm + 1.0) / 60.0  # degrees lat, 1nm extra margin
    cos_lat = math.cos(math.radians((from_lat + to_lat) / 2))
    pad_lon = pad / max(cos_lat, 0.01)
    min_lat = min(from_lat, to_lat) - pad
    max_lat = max(from_lat, to_lat) + pad
    min_lon = min(from_lon, to_lon) - pad_lon
    max_lon = max(from_lon, to_lon) + pad_lon

    db = get_db()
    rows = db.execute('''
        SELECT label, lat, lon, name
        FROM features
        WHERE category = 'hazard'
          AND lat BETWEEN ? AND ?
          AND lon BETWEEN ? AND ?
    ''', (min_lat, max_lat, min_lon, max_lon)).fetchall()

    R = 3440.065

    def _brg(lon1, lat1, lon2, lat2):
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dlam = math.radians(lon2 - lon1)
        y = math.sin(dlam) * math.cos(phi2)
        x = math.cos(phi1)*math.sin(phi2) - math.sin(phi1)*math.cos(phi2)*math.cos(dlam)
        return math.atan2(y, x)

    def _cross_track(p_lon, p_lat):
        d13 = haversine_nm(from_lat, from_lon, p_lat, p_lon) / R
        if d13 < 1e-9:
            return 0.0, 0.0
        b13 = _brg(from_lon, from_lat, p_lon, p_lat)
        b12 = _brg(from_lon, from_lat, to_lon, to_lat)
        dxt = math.asin(math.sin(d13) * math.sin(b13 - b12)) * R
        cos_dxt = math.cos(dxt / R)
        if abs(cos_dxt) < 1e-10:
            return None, None
        dat = math.acos(max(-1.0, min(1.0, math.cos(d13) / cos_dxt))) * R
        return dxt, dat

    d_ab = haversine_nm(from_lat, from_lon, to_lat, to_lon)
    PRIORITY = {'underwater rock': 2, 'obstruction': 2, 'wreck': 2, 'shallow area': 1}

    results = []
    for label, flat, flon, name in rows:
        if PRIORITY.get(label, 2) == 1 and not name:
            continue
        dxt, dat = _cross_track(flon, flat)
        if dxt is None:
            continue
        if abs(dxt) <= corridor_nm and 0 <= dat <= d_ab:
            results.append({
                'lat': flat,
                'lon': flon,
                'label': label,
                'name': name or '',
                'along_track_nm': round(dat, 3),
                'cross_track_nm': round(abs(dxt), 3),
                'side': 'port' if dxt <= 0 else 'starboard',
            })

    results.sort(key=lambda r: r['along_track_nm'])
    return {'hazards': results, 'count': len(results), 'course_length_nm': round(d_ab, 2)}


_LANDMARK_LABELS = {'town', 'island', 'coastal feature', 'anchorage'}

def find_nearest_landmark(lat, lon, radius_nm=25.0):
    """
    Return the best human-readable reference point near (lat, lon).
    Prefers town/island/coastal feature/anchorage; falls back to any named place.
    Returns {name, label, dist_nm, bearing_deg} or None.
    """
    deg_lat = radius_nm / 60.0
    deg_lon = radius_nm / (60.0 * math.cos(math.radians(lat)))

    db = get_db()
    rows = db.execute('''
        SELECT label, lat, lon, name
        FROM features
        WHERE category = 'place' AND name IS NOT NULL
          AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
    ''', (lat - deg_lat, lat + deg_lat, lon - deg_lon, lon + deg_lon)).fetchall()

    preferred = None; pref_dist = math.inf
    fallback  = None; fall_dist = math.inf

    for label, flat, flon, name in rows:
        if not name:
            continue
        d = haversine_nm(lat, lon, flat, flon)
        if d > radius_nm:
            continue
        if label in _LANDMARK_LABELS and d < pref_dist:
            pref_dist = d
            preferred = (label, flat, flon, name, d)
        if d < fall_dist:
            fall_dist = d
            fallback = (label, flat, flon, name, d)

    best = preferred or fallback
    if not best:
        return None

    label, flat, flon, name, dist = best

    # Bearing FROM landmark TO vessel (so we can say "X nm SW of Rockland")
    phi1, phi2 = math.radians(flat), math.radians(lat)
    dlam = math.radians(lon - flon)
    y = math.sin(dlam) * math.cos(phi2)
    x = math.cos(phi1)*math.sin(phi2) - math.sin(phi1)*math.cos(phi2)*math.cos(dlam)
    brg = (math.degrees(math.atan2(y, x)) + 360) % 360

    return {'name': name, 'label': label, 'dist_nm': round(dist, 2), 'bearing_deg': round(brg, 1)}


def get_route_segment_hazards(waypoints, corridor_nm=0.25):
    """
    Check hazards along every leg of a multi-point route.
    waypoints: list of {lat, lon} dicts in order.
    Returns same format as get_course_hazards with cumulative along_track_nm.
    """
    seen = {}
    cumulative = 0.0

    for i in range(len(waypoints) - 1):
        a, b = waypoints[i], waypoints[i + 1]
        leg = get_course_hazards(a['lat'], a['lon'], b['lat'], b['lon'], corridor_nm)
        for h in leg['hazards']:
            key = f"{h['lat']:.4f},{h['lon']:.4f}"
            if key not in seen:
                h_copy = dict(h)
                h_copy['along_track_nm'] = round(h['along_track_nm'] + cumulative, 3)
                seen[key] = h_copy
        cumulative += leg['course_length_nm']

    results = sorted(seen.values(), key=lambda h: h['along_track_nm'])
    return {'hazards': results, 'count': len(results), 'course_length_nm': round(cumulative, 2)}


async def process_all_charts():
    """Process all ENC files in ENC_BASE. Runs at server startup."""
    files = find_enc_files()
    total = len(files)
    done = 0
    new = 0
    print(f'[chartdb] Found {total} ENC charts in {ENC_BASE}')
    for enc_path in files:
        n, chart_id = await asyncio.get_event_loop().run_in_executor(
            None, process_chart_file, enc_path
        )
        done += 1
        if n > 0:
            new += 1
            print(f'[chartdb] {done}/{total} {chart_id}: {n} features')
        elif done % 20 == 0:
            print(f'[chartdb] {done}/{total} charts checked...')
    print(f'[chartdb] Done. {new} new charts processed.')
