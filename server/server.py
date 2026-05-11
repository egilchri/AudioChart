#!/usr/bin/env python3
"""
AudioChart local server — runs on Mac below decks.
Serves the PWA + nautical tiles + GPS WebSocket + dynamic chart API.

Usage:
  pip3 install aiohttp
  python3 server/server.py

Then visit http://<mac-ip>:8080 on your Android phone.
"""
import asyncio
import gzip as _gzip
import json
import os
import socket
import sys

try:
    from aiohttp import web
except ImportError:
    print('Missing aiohttp. Run: pip3 install aiohttp')
    sys.exit(1)

import tile_server
from nmea_bridge import bridge
import opencpn_bridge
import chartdb
import opencpn_waypoints

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WWW_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '../www'))
PORT = 8080
NMEA_PORT = 10112

# Test-position state (set by POST /api/test-position from the phone)
_test_position = None   # {'lat': float, 'lon': float} or None
_nmea_clients = set()   # asyncio StreamWriter connections from OpenCPN


async def handle_tile(request):
    z = int(request.match_info['z'])
    x = int(request.match_info['x'])
    y = int(request.match_info['y'])
    try:
        data = tile_server.get_tile(z, x, y)
    except FileNotFoundError as e:
        return web.Response(status=503, text=str(e))
    if data is None:
        return web.Response(status=404)
    return web.Response(body=data, content_type='image/jpeg',
                        headers={'Cache-Control': 'public, max-age=86400'})


def _json_response(request, data):
    """Build a JSON response with optional gzip encoding."""
    body = json.dumps(data, separators=(',', ':')).encode()
    headers = {'Access-Control-Allow-Origin': '*', 'Vary': 'Accept-Encoding'}
    if 'gzip' in request.headers.get('Accept-Encoding', ''):
        body = _gzip.compress(body, compresslevel=6)
        headers['Content-Encoding'] = 'gzip'
    return web.Response(body=body, content_type='application/json', headers=headers)


async def handle_waypoints(request):
    """GET /api/waypoints — returns all named OpenCPN waypoints, fresh from navobj.db."""
    waypoints = await asyncio.get_event_loop().run_in_executor(
        None, opencpn_waypoints.get_waypoints
    )
    return _json_response(request, {
        'type': 'FeatureCollection',
        'features': waypoints,
        'count': len(waypoints),
    })


async def handle_nearby(request):
    """
    GET /api/nearby?lat=44.1&lon=-69.1&radius=15
    Returns GeoJSON hazards, places, navaids and MAGVAR within radius_nm.
    This replaces the static data/ files with a live, position-aware response.
    """
    try:
        lat = float(request.rel_url.query.get('lat', 0))
        lon = float(request.rel_url.query.get('lon', 0))
        radius = float(request.rel_url.query.get('radius', chartdb.DEFAULT_RADIUS_NM))
    except ValueError:
        return web.Response(status=400, text='Invalid lat/lon/radius')

    if lat == 0 and lon == 0:
        return web.Response(status=400, text='lat and lon required')

    result = await asyncio.get_event_loop().run_in_executor(
        None, chartdb.get_nearby, lat, lon, radius
    )
    return _json_response(request, result)


async def handle_gps_ws(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    initial = bridge.register(ws)
    if initial:
        await ws.send_str(json.dumps(initial))
    try:
        async for _ in ws:
            pass
    finally:
        bridge.unregister(ws)
    return ws


def _nmea_checksum(sentence):
    """XOR checksum of all characters between $ and * (exclusive)."""
    cs = 0
    for ch in sentence:
        cs ^= ord(ch)
    return f'{cs:02X}'


def make_gprmc(lat, lon):
    """Build a minimal valid $GPRMC sentence for the given decimal lat/lon."""
    import datetime
    now = datetime.datetime.utcnow()
    time_str = now.strftime('%H%M%S.00')
    date_str = now.strftime('%d%m%y')

    lat_deg = int(abs(lat))
    lat_min = (abs(lat) - lat_deg) * 60
    lon_deg = int(abs(lon))
    lon_min = (abs(lon) - lon_deg) * 60
    ns = 'N' if lat >= 0 else 'S'
    ew = 'E' if lon >= 0 else 'W'

    body = f'GPRMC,{time_str},A,{lat_deg:02d}{lat_min:07.4f},{ns},{lon_deg:03d}{lon_min:07.4f},{ew},0.0,0.0,{date_str},,,A'
    return f'${body}*{_nmea_checksum(body)}\r\n'


async def handle_nmea_client(reader, writer):
    """Raw TCP handler — OpenCPN connects here to receive test-position NMEA."""
    _nmea_clients.add(writer)
    try:
        await reader.read(1024)   # wait until client closes
    except Exception:
        pass
    finally:
        _nmea_clients.discard(writer)
        try:
            writer.close()
        except Exception:
            pass


async def nmea_broadcast_loop():
    """Send $GPRMC at 1 Hz to all connected NMEA clients when test position is active."""
    while True:
        if _test_position and _nmea_clients:
            sentence = make_gprmc(_test_position['lat'], _test_position['lon'])
            for w in list(_nmea_clients):
                try:
                    w.write(sentence.encode())
                    await w.drain()
                except Exception:
                    _nmea_clients.discard(w)
        await asyncio.sleep(1.0)


async def handle_find_place(request):
    """GET /api/find-place?q=Southwest+Harbor — full-DB place name lookup."""
    q = request.rel_url.query.get('q', '').strip()
    if not q:
        return web.Response(status=400, text='q required')
    result = await asyncio.get_event_loop().run_in_executor(
        None, chartdb.find_place_by_name, q
    )
    if result is None:
        return web.Response(status=404, text='Not found')
    return _json_response(request, result)


async def handle_set_test_position(request):
    """POST /api/test-position  body: {"lat":44.1,"lon":-69.0} or {} to clear."""
    global _test_position
    try:
        data = await request.json()
        if 'lat' in data and 'lon' in data:
            _test_position = {'lat': float(data['lat']), 'lon': float(data['lon'])}
        else:
            _test_position = None
    except Exception:
        _test_position = None
    return web.Response(
        body=json.dumps({'ok': True}),
        content_type='application/json',
        headers={'Access-Control-Allow-Origin': '*'},
    )


async def handle_static(request):
    """Serve files from www/ with SPA fallback to index.html."""
    path = request.match_info.get('path', '')
    safe_path = os.path.normpath(path).lstrip('/')
    full_path = os.path.join(WWW_DIR, safe_path)
    if os.path.isfile(full_path):
        return web.FileResponse(full_path, headers={'Cache-Control': 'no-cache'})
    index = os.path.join(WWW_DIR, 'index.html')
    if os.path.isfile(index):
        return web.FileResponse(index)
    return web.Response(status=404)


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def local_hostname():
    try:
        return socket.gethostname() + '.local'
    except Exception:
        return None


CONNECT_PAGE_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect to AudioChart</title>
<style>
  body {{ font-family: system-ui, sans-serif; background: #0a1628; color: #e8edf4;
         display: flex; flex-direction: column; align-items: center;
         justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }}
  h1 {{ color: #4a9edd; margin-bottom: 8px; font-size: 1.4rem; }}
  p  {{ color: #8a9ab0; margin-bottom: 24px; text-align: center; }}
  #qr {{ background: white; padding: 16px; border-radius: 12px; margin-bottom: 20px; }}
  .url {{ font-family: monospace; font-size: 1rem; color: #4a9edd;
          background: #1a3a5c; padding: 10px 16px; border-radius: 8px;
          word-break: break-all; text-align: center; max-width: 340px; }}
  .hint {{ color: #8a9ab0; font-size: 0.85rem; margin-top: 16px; text-align: center; }}
</style>
</head>
<body>
<h1>&#9875; AudioChart</h1>
<p>Scan with your phone camera to open the app</p>
<div id="qr"></div>
<div class="url">{url}</div>
<p class="hint">Or type the address above into Chrome on your phone.</p>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  new QRCode(document.getElementById('qr'), {{
    text: '{url}',
    width: 220, height: 220,
    colorDark: '#000000', colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  }});
</script>
</body>
</html>
"""


async def handle_connect(request):
    ip = local_ip()
    url = f'http://{ip}:{PORT}'
    html = CONNECT_PAGE_TEMPLATE.format(url=url)
    return web.Response(text=html, content_type='text/html')


async def main():
    app = web.Application()
    app.router.add_get('/api/waypoints', handle_waypoints)
    app.router.add_get('/api/nearby', handle_nearby)
    app.router.add_get('/api/find-place', handle_find_place)
    app.router.add_post('/api/test-position', handle_set_test_position)
    app.router.add_get('/tiles/{z}/{x}/{y}.jpg', handle_tile)
    app.router.add_get('/ws/gps', handle_gps_ws)
    app.router.add_get('/connect', handle_connect)
    app.router.add_get('/', handle_static)
    app.router.add_get('/{path:.*}', handle_static)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', PORT)
    await site.start()

    ip = local_ip()
    hostname = local_hostname()
    print(f'\nAudioChart server running.')
    print(f'  Local:    http://localhost:{PORT}')
    print(f'  Network:  http://{ip}:{PORT}')
    if hostname:
        print(f'  Bonjour:  http://{hostname}:{PORT}')
    print(f'  NMEA out: localhost:{NMEA_PORT}  (add to OpenCPN as TCP Input for test-position)')
    print(f'\nTo connect your phone — open this on your Mac:')
    print(f'  http://localhost:{PORT}/connect')
    print(f'Then scan the QR code with your phone camera.')
    print(f'\nPress Ctrl+C to stop.')
    print(f'(GPS puck and OpenCPN TCP NMEA are optional — errors are silenced)\n')

    # Process all ENC charts in background (skips already-processed ones)
    asyncio.create_task(chartdb.process_all_charts())

    # Start NMEA and OpenCPN bridges
    asyncio.create_task(bridge.run())
    opencpn_bridge.set_broadcast(bridge.broadcast)
    asyncio.create_task(opencpn_bridge.run())

    # TCP NMEA server for OpenCPN test-position injection
    nmea_server = await asyncio.start_server(handle_nmea_client, '127.0.0.1', NMEA_PORT)
    asyncio.create_task(nmea_server.serve_forever())
    asyncio.create_task(nmea_broadcast_loop())

    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await runner.cleanup()


if __name__ == '__main__':
    asyncio.run(main())
