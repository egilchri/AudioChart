"""
OpenCPN position bridge.

Priority order:
1. OpenCPN NMEA TCP output (real-time, requires one-time OpenCPN config)
2. navobj.db track point polling (no config, updates every few seconds)

To enable real-time NMEA from OpenCPN:
  OpenCPN → Options → Connections → Add Connection
    Type: Network | Protocol: TCP
    Address: localhost | DataPort: 10110
    I/O Direction: Output only
"""

import asyncio
import json
import os
import re
import sqlite3

OPENCPN_TCP_HOST = 'localhost'
OPENCPN_TCP_PORT = 10110          # change if you used a different port in OpenCPN

NAVOBJ_DB = os.path.expanduser(
    '~/Library/Preferences/opencpn/navobj.db'
)
OPENCPN_INI = os.path.expanduser(
    '~/Library/Preferences/opencpn/opencpn.ini'
)
POLL_INTERVAL = 2.0               # seconds between polls
STALE_SECONDS = 300               # ignore track points older than this

_broadcast_fn = None              # set by server.py


def set_broadcast(fn):
    """Register the function to call when we have a new position."""
    global _broadcast_fn
    _broadcast_fn = fn


async def _emit(lat, lon, source):
    if _broadcast_fn:
        await _broadcast_fn(lat, lon, source)


# ── NMEA helpers ─────────────────────────────────────────────────────────────

def _parse_rmc(sentence):
    """Parse $GPRMC / $GNRMC → (lat, lon) or None."""
    parts = sentence.strip().split(',')
    if len(parts) < 7 or parts[2] != 'A':
        return None
    try:
        lat_raw, lat_dir = parts[3], parts[4]
        lon_raw, lon_dir = parts[5], parts[6]
        if not lat_raw or not lon_raw:
            return None
        lat = float(lat_raw[:2]) + float(lat_raw[2:]) / 60
        lon = float(lon_raw[:3]) + float(lon_raw[3:]) / 60
        if lat_dir == 'S': lat = -lat
        if lon_dir == 'W': lon = -lon
        return lat, lon
    except (ValueError, IndexError):
        return None


def _parse_gll(sentence):
    """Parse $GPGLL → (lat, lon) or None."""
    parts = sentence.strip().split(',')
    if len(parts) < 6 or parts[6] != 'A' if len(parts) > 6 else parts[5] != 'A':
        return None
    try:
        lat_raw, lat_dir = parts[1], parts[2]
        lon_raw, lon_dir = parts[3], parts[4]
        lat = float(lat_raw[:2]) + float(lat_raw[2:]) / 60
        lon = float(lon_raw[:3]) + float(lon_raw[3:]) / 60
        if lat_dir == 'S': lat = -lat
        if lon_dir == 'W': lon = -lon
        return lat, lon
    except (ValueError, IndexError):
        return None


# ── TCP NMEA reader ───────────────────────────────────────────────────────────

async def run_tcp_nmea():
    """
    Try to read NMEA from OpenCPN's TCP output.
    Returns True if we connected and read at least one position.
    """
    while True:
        try:
            reader, _ = await asyncio.wait_for(
                asyncio.open_connection(OPENCPN_TCP_HOST, OPENCPN_TCP_PORT),
                timeout=3
            )
            print(f'[opencpn] Connected to NMEA TCP at {OPENCPN_TCP_HOST}:{OPENCPN_TCP_PORT}')
            buf = b''
            while True:
                chunk = await reader.read(256)
                if not chunk:
                    break
                buf += chunk
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    sentence = line.decode('ascii', errors='ignore').strip()
                    pos = None
                    if sentence.startswith(('$GPRMC', '$GNRMC')):
                        pos = _parse_rmc(sentence)
                    elif sentence.startswith(('$GPGLL', '$GNGLL')):
                        pos = _parse_gll(sentence)
                    if pos:
                        await _emit(pos[0], pos[1], 'opencpn-nmea')
        except Exception:
            await asyncio.sleep(10)
            await asyncio.sleep(5)


# ── opencpn.ini OwnShipLatLon poller ─────────────────────────────────────────

async def run_ini_poll():
    """
    Poll OwnShipLatLon from opencpn.ini.
    OpenCPN writes this field whenever the ship position is known.
    Works with no OpenCPN configuration — zero setup required.
    """
    if not os.path.exists(OPENCPN_INI):
        return

    last_pos = None
    print(f'[opencpn] Polling opencpn.ini for OwnShipLatLon every {POLL_INTERVAL}s')

    while True:
        try:
            with open(OPENCPN_INI, 'r', errors='ignore') as f:
                for line in f:
                    if line.startswith('OwnShipLatLon='):
                        value = line.split('=', 1)[1].strip().strip('"')
                        parts = [p.strip() for p in value.split(',')]
                        if len(parts) == 2:
                            lat, lon = float(parts[0]), float(parts[1])
                            pos = (lat, lon)
                            if pos != last_pos and lat != 0.0:
                                last_pos = pos
                                await _emit(lat, lon, 'opencpn-ini')
                        break
        except Exception as e:
            print(f'[opencpn] ini poll error: {e}')

        await asyncio.sleep(POLL_INTERVAL)


# ── navobj.db poller ──────────────────────────────────────────────────────────

async def run_db_poll():
    """
    Poll OpenCPN's navobj.db for the most recent track point.
    Only runs when TCP NMEA isn't delivering positions.
    """
    if not os.path.exists(NAVOBJ_DB):
        print(f'[opencpn] navobj.db not found at {NAVOBJ_DB}')
        return

    last_pos = None
    print(f'[opencpn] Polling navobj.db for OpenCPN ship position every {POLL_INTERVAL}s')

    while True:
        try:
            # Use WAL mode check — OpenCPN may have the DB open
            conn = sqlite3.connect(f'file:{NAVOBJ_DB}?mode=ro', uri=True,
                                   check_same_thread=False)
            conn.row_factory = sqlite3.Row
            row = conn.execute('''
                SELECT latitude, longitude, timestamp
                FROM trk_points
                ORDER BY rowid DESC
                LIMIT 1
            ''').fetchone()
            conn.close()

            if row:
                import datetime
                lat, lon, ts = row['latitude'], row['longitude'], row['timestamp']

                # Check staleness
                try:
                    t = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00'))
                    age = (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()
                    if age > STALE_SECONDS:
                        await asyncio.sleep(POLL_INTERVAL)
                        continue
                except Exception:
                    pass  # if we can't parse timestamp, trust it anyway

                pos = (lat, lon)
                if pos != last_pos:
                    last_pos = pos
                    await _emit(lat, lon, 'opencpn-track')

        except Exception as e:
            print(f'[opencpn] DB poll error: {e}')

        await asyncio.sleep(POLL_INTERVAL)


# ── Entry point called from server.py ────────────────────────────────────────

async def run():
    """Run all OpenCPN position sources concurrently."""
    await asyncio.gather(
        run_tcp_nmea(),    # real-time NMEA (requires OpenCPN TCP output config)
        run_ini_poll(),    # OwnShipLatLon from opencpn.ini (zero config)
        run_db_poll(),     # navobj.db track points (fallback)
    )
