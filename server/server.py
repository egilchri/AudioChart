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


async def handle_waypoints(request):
    """GET /api/waypoints — returns all named OpenCPN waypoints, fresh from navobj.db."""
    waypoints = await asyncio.get_event_loop().run_in_executor(
        None, opencpn_waypoints.get_waypoints
    )
    body = json.dumps({
        'type': 'FeatureCollection',
        'features': waypoints,
        'count': len(waypoints),
    }, separators=(',', ':'))
    return web.Response(
        body=body,
        content_type='application/json',
        headers={'Access-Control-Allow-Origin': '*'},
    )


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
    return web.Response(
        body=json.dumps(result, separators=(',', ':')),
        content_type='application/json',
        headers={'Access-Control-Allow-Origin': '*'},
    )


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


async def main():
    app = web.Application()
    app.router.add_get('/api/waypoints', handle_waypoints)
    app.router.add_get('/api/nearby', handle_nearby)
    app.router.add_get('/tiles/{z}/{x}/{y}.jpg', handle_tile)
    app.router.add_get('/ws/gps', handle_gps_ws)
    app.router.add_get('/', handle_static)
    app.router.add_get('/{path:.*}', handle_static)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', PORT)
    await site.start()

    ip = local_ip()
    print(f'\nAudioChart server running.')
    print(f'  Local:    http://localhost:{PORT}')
    print(f'  Network:  http://{ip}:{PORT}')
    print(f'\nOn your Android phone:')
    print(f'  1. Connect phone to this Mac\'s network (or share Mac via phone hotspot)')
    print(f'  2. Open Chrome and visit http://{ip}:{PORT}')
    print(f'  3. Tap the install button to add as home screen app')
    print(f'\nPress Ctrl+C to stop.\n')

    # Process all ENC charts in background (skips already-processed ones)
    asyncio.create_task(chartdb.process_all_charts())

    # Start NMEA and OpenCPN bridges
    asyncio.create_task(bridge.run())
    opencpn_bridge.set_broadcast(bridge.broadcast)
    asyncio.create_task(opencpn_bridge.run())

    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await runner.cleanup()


if __name__ == '__main__':
    asyncio.run(main())
