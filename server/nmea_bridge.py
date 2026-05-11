"""
NMEA GPS puck → WebSocket bridge.
Reads $GPRMC / $GNRMC sentences from a USB serial GPS and broadcasts
position JSON to all connected WebSocket clients.
"""
import asyncio
import json
import re
import socket

SERIAL_PORT = '/dev/cu.PL2303G-USBtoUART110'
BAUD_RATE = 4800
RECONNECT_DELAY = 5


def parse_rmc(sentence):
    """Parse $GPRMC or $GNRMC sentence. Returns (lat, lon) or None."""
    # $GPRMC,HHMMSS,A,DDMM.MMMM,N,DDDMM.MMMM,W,knots,track,date,...
    parts = sentence.strip().split(',')
    if len(parts) < 7:
        return None
    status = parts[2]
    if status != 'A':
        return None  # not active fix
    try:
        lat_raw, lat_dir = parts[3], parts[4]
        lon_raw, lon_dir = parts[5], parts[6]
        if not lat_raw or not lon_raw:
            return None
        lat_deg = float(lat_raw[:2]) + float(lat_raw[2:]) / 60
        lon_deg = float(lon_raw[:3]) + float(lon_raw[3:]) / 60
        if lat_dir == 'S':
            lat_deg = -lat_deg
        if lon_dir == 'W':
            lon_deg = -lon_deg
        return lat_deg, lon_deg
    except (ValueError, IndexError):
        return None


class NMEABridge:
    def __init__(self):
        self.clients = set()
        self.last_position = None

    def register(self, ws):
        self.clients.add(ws)
        if self.last_position:
            return self.last_position
        return None

    def unregister(self, ws):
        self.clients.discard(ws)

    async def broadcast(self, lat, lon, source='nmea'):
        self.last_position = {'lat': lat, 'lon': lon, 'source': source}
        if not self.clients:
            return
        msg = json.dumps(self.last_position)
        dead = set()
        for ws in self.clients:
            try:
                await ws.send_str(msg)
            except Exception:
                dead.add(ws)
        self.clients -= dead

    async def run(self):
        """Continuously read NMEA from serial and broadcast."""
        import serial
        while True:
            try:
                with serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=2) as ser:
                    print(f'[nmea] Connected to {SERIAL_PORT}')
                    buf = b''
                    while True:
                        chunk = ser.read(64)
                        if not chunk:
                            continue
                        buf += chunk
                        while b'\n' in buf:
                            line, buf = buf.split(b'\n', 1)
                            try:
                                sentence = line.decode('ascii', errors='ignore').strip()
                            except Exception:
                                continue
                            if sentence.startswith(('$GPRMC', '$GNRMC')):
                                pos = parse_rmc(sentence)
                                if pos:
                                    await self.broadcast(*pos)
            except Exception as e:
                print(f'[nmea] Serial error: {e} — retrying in {RECONNECT_DELAY}s')
                await asyncio.sleep(RECONNECT_DELAY)


bridge = NMEABridge()
