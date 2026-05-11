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


def find_place_by_name(query):
    """
    Search the full chart database for a named place matching query.
    Returns {'lat', 'lon', 'name'} for the best match, or None.
    Prefers town/harbour labels over generic sea areas when names are identical.
    """
    q = query.strip().lower()
    db = get_db()

    # Exact match first (fast, uses index)
    rows = db.execute(
        "SELECT label, lat, lon, name FROM features WHERE name_lower = ? ORDER BY ROWID",
        (q,)
    ).fetchall()

    if rows:
        # Multiple exact matches — pick highest-rank label
        best = max(rows, key=lambda r: LABEL_RANK.get(r[0], 1))
        return {'lat': best[1], 'lon': best[2], 'name': best[3]}

    # Fuzzy fallback: fetch candidates that share words, score by similarity
    words = q.split()
    if not words:
        return None
    like = f'%{words[0]}%'
    rows = db.execute(
        "SELECT label, lat, lon, name, name_lower FROM features WHERE name_lower LIKE ? LIMIT 200",
        (like,)
    ).fetchall()

    def score(row):
        nl = row[4]
        if nl == q:
            return 1.0 + LABEL_RANK.get(row[0], 1) * 0.001
        if q in nl:
            base = len(q) / len(nl)
        elif nl in q:
            base = len(nl) / len(q)
        else:
            dist = sum(1 for a, b in zip(q, nl) if a != b) + abs(len(q) - len(nl))
            base = 1 - dist / max(len(q), len(nl), 1)
        return base + LABEL_RANK.get(row[0], 1) * 0.001

    if not rows:
        return None
    best = max(rows, key=score)
    if score(best) < 0.5:
        return None
    return {'lat': best[1], 'lon': best[2], 'name': best[3]}


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
