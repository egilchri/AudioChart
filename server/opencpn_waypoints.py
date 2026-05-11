"""
Read named waypoints from OpenCPN's navobj.db.
Waypoints are checked on every request so newly-added marks appear immediately.
"""
import os
import sqlite3

NAVOBJ_DB = os.path.expanduser('~/Library/Preferences/opencpn/navobj.db')


def get_route_by_name(name):
    """
    Find a named OpenCPN route by case-insensitive fuzzy match.
    Returns {name, points: [{lat, lon, name}, ...]} or None.
    """
    if not os.path.exists(NAVOBJ_DB):
        return None
    try:
        conn = sqlite3.connect(f'file:{NAVOBJ_DB}?mode=ro', uri=True)
        conn.row_factory = sqlite3.Row
        name_lower = name.strip().lower()

        routes = conn.execute(
            "SELECT guid, name FROM routes WHERE name != '' ORDER BY created_at DESC"
        ).fetchall()

        best_guid, best_name, best_score = None, None, 0.0
        for row in routes:
            rn = row['name'].lower()
            if rn == name_lower:
                score = 1.0
            elif name_lower in rn or rn in name_lower:
                score = min(len(name_lower), len(rn)) / max(len(name_lower), len(rn))
            else:
                words_q = set(name_lower.split())
                words_r = set(rn.split())
                overlap = len(words_q & words_r)
                score = overlap / max(len(words_q), len(words_r), 1)
            if score > best_score:
                best_score = score
                best_guid = row['guid']
                best_name = row['name']

        if not best_guid or best_score < 0.4:
            conn.close()
            return None

        rows = conn.execute('''
            SELECT rp.lat, rp.lon, rp.Name
            FROM routepoints rp
            JOIN routepoints_link rl ON rp.guid = rl.point_guid
            WHERE rl.route_guid = ?
            ORDER BY rl.point_order
        ''', (best_guid,)).fetchall()
        conn.close()

        if not rows:
            return None
        # Build points and strip consecutive duplicates
        points = [{'lat': r['lat'], 'lon': r['lon'], 'name': r['Name'] or ''} for r in rows]
        deduped = [points[0]]
        for p in points[1:]:
            if abs(p['lat'] - deduped[-1]['lat']) > 1e-6 or abs(p['lon'] - deduped[-1]['lon']) > 1e-6:
                deduped.append(p)
        return {'name': best_name, 'points': deduped}
    except Exception as e:
        print(f'[routes] DB error: {e}')
        return None


def get_waypoints():
    """
    Return all named waypoints as a list of dicts.
    Uses both Name and description fields; skips entries with neither.
    """
    if not os.path.exists(NAVOBJ_DB):
        return []
    try:
        conn = sqlite3.connect(f'file:{NAVOBJ_DB}?mode=ro', uri=True)
        conn.row_factory = sqlite3.Row
        rows = conn.execute('''
            SELECT guid, lat, lon, Name, description, Symbol, created_at
            FROM routepoints
            WHERE lat != 0 AND lon != 0
            ORDER BY created_at DESC
        ''').fetchall()
        conn.close()
    except Exception as e:
        print(f'[waypoints] DB error: {e}')
        return []

    waypoints = []
    for row in rows:
        name = (row['Name'] or '').strip()
        desc = (row['description'] or '').strip()
        label = name or desc
        if not label:
            continue
        waypoints.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [row['lon'], row['lat']]},
            'properties': {
                'name': label,
                'name_lower': label.lower(),
                'symbol': row['Symbol'] or '',
                'guid': row['guid'],
                'source': 'opencpn-waypoint',
            },
        })
    return waypoints
