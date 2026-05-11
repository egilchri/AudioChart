"""
Read named waypoints from OpenCPN's navobj.db.
Waypoints are checked on every request so newly-added marks appear immediately.
"""
import os
import sqlite3

NAVOBJ_DB = os.path.expanduser('~/Library/Preferences/opencpn/navobj.db')


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
