"""
MBTiles SQLite → HTTP tile endpoint.
Serves tiles at /tiles/{z}/{x}/{y}.jpg from the local .mbtiles file.
"""
import sqlite3
import os

MBTILES_PATH = '/Users/edgargilchrist/Documents/Charts/MBTiles/penobscot-esri-z16.mbtiles'

_conn = None


def get_conn():
    global _conn
    if _conn is None:
        if not os.path.exists(MBTILES_PATH):
            raise FileNotFoundError(f'MBTiles not found: {MBTILES_PATH}')
        _conn = sqlite3.connect(MBTILES_PATH, check_same_thread=False)
    return _conn


def get_tile(z, x, y):
    """
    Return tile bytes for Leaflet TMS coordinates or None if not found.
    MBTiles uses TMS y (flipped): y_mbtiles = (2^z - 1 - y_leaflet)
    """
    y_mbtiles = (1 << z) - 1 - y
    conn = get_conn()
    row = conn.execute(
        'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?',
        (z, x, y_mbtiles),
    ).fetchone()
    return row[0] if row else None
