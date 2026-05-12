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


COURSE_MAP_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TITLE_PLACEHOLDER</title>
<link rel="stylesheet" href="/css/leaflet.css">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a1628;font-family:system-ui,sans-serif}
  #map{width:100vw;height:100vh}
  #hud{
    position:absolute;top:12px;left:50px;z-index:1000;
    background:rgba(10,22,40,.9);color:#e8edf4;
    padding:9px 16px;border-radius:8px;font-size:.85rem;
    border:1px solid #2a5080;pointer-events:none;
  }
  #hud strong{color:#4a9edd;display:block;font-size:1rem;margin-bottom:2px}
  .tt{
    background:#1a3a5c!important;border:1px solid #2a5080!important;
    color:#e8edf4!important;font-size:.75rem;padding:2px 6px;
    white-space:nowrap;box-shadow:none!important;
  }
  .tt::before{border-top-color:#2a5080!important}
</style>
</head>
<body>
<div id="hud"><strong>&#9875; AudioChart</strong><span id="subtitle">Loading hazards…</span></div>
<div id="map"></div>
<script src="/js/lib/leaflet.js"></script>
<script>
const FROM=[FROM_LAT,FROM_LON], TO=[TO_LAT,TO_LON];
const FROM_NAME=FROM_NAME_JSON, TO_NAME=TO_NAME_JSON;
const map=L.map('map',{zoomControl:true});
L.tileLayer('/tiles/{z}/{x}/{y}.jpg',{minZoom:8,maxZoom:16}).addTo(map);
const dot=(ll,c,label,dir)=>L.circleMarker(ll,{radius:9,color:c,fillColor:c,fillOpacity:1,weight:0})
  .bindTooltip(label,{permanent:true,direction:dir,className:'tt'}).addTo(map);
const straightLine=L.polyline([FROM,TO],{color:'#4a9edd',weight:3,dashArray:'8 4',opacity:.9}).addTo(map);
dot(FROM,'#4a9edd',FROM_NAME,'right');
dot(TO,'#4a9edd',TO_NAME,'left');
map.fitBounds(L.latLngBounds([FROM,TO]).pad(.2));
const ROUTE_NAME=ROUTE_NAME_JSON;
const hazardUrl=ROUTE_NAME
  ?'/api/route-hazards?name='+encodeURIComponent(ROUTE_NAME)
  :'/api/course-hazards?from_lat=FROM_LAT&from_lon=FROM_LON&to_lat=TO_LAT&to_lon=TO_LON';
fetch(hazardUrl)
  .then(r=>r.json()).then(d=>{
    const pts=[FROM,TO];
    // If multi-leg route, draw the actual waypoints as a polyline
    if(d.waypoints&&d.waypoints.length>2){
      map.removeLayer(straightLine);
      const wpts=d.waypoints.map(w=>[w.lat,w.lon]);
      L.polyline(wpts,{color:'#4a9edd',weight:3,dashArray:'8 4',opacity:.9}).addTo(map);
      pts.push(...wpts);
    }
    d.hazards.forEach(h=>{
      const lbl=h.name?h.name+' ('+h.label+')':h.label;
      L.circleMarker([h.lat,h.lon],{radius:8,color:'#e0a030',fillColor:'#e0a030',fillOpacity:.85,weight:1.5})
        .bindTooltip(lbl,{className:'tt',direction:'top'}).addTo(map);
      pts.push([h.lat,h.lon]);
    });
    map.fitBounds(L.latLngBounds(pts).pad(.15));
    const title=ROUTE_NAME||FROM_NAME+' → '+TO_NAME;
    document.getElementById('subtitle').textContent=
      title+' — '+d.count+' hazard'+(d.count===1?'':'s');
  }).catch(()=>{});
</script>
</body>
</html>"""


def _build_course_map(from_lat, from_lon, to_lat, to_lon, from_name, to_name, route_name=None):
    import json
    title = f'AudioChart: {route_name or (from_name + " → " + to_name)}'
    return (COURSE_MAP_HTML
        .replace('TITLE_PLACEHOLDER', title)
        .replace('FROM_LAT',        str(from_lat))
        .replace('FROM_LON',        str(from_lon))
        .replace('TO_LAT',          str(to_lat))
        .replace('TO_LON',          str(to_lon))
        .replace('FROM_NAME_JSON',  json.dumps(from_name))
        .replace('TO_NAME_JSON',    json.dumps(to_name))
        .replace('ROUTE_NAME_JSON', json.dumps(route_name))
    )


async def handle_course_map(request):
    """GET /course-map?from_lat=…&from_lon=…&to_lat=…&to_lon=…&from_name=…&to_name=…"""
    q = request.rel_url.query
    try:
        from_lat = float(q['from_lat'])
        from_lon = float(q['from_lon'])
        to_lat   = float(q['to_lat'])
        to_lon   = float(q['to_lon'])
    except (KeyError, ValueError):
        return web.Response(status=400, text='from_lat, from_lon, to_lat, to_lon required')
    from_name  = q.get('from_name', 'Start')
    to_name    = q.get('to_name', 'End')
    route_name = q.get('route_name') or None
    html = _build_course_map(from_lat, from_lon, to_lat, to_lon, from_name, to_name, route_name)
    return web.Response(text=html, content_type='text/html')


def _xml_escape(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;')
             .replace('>', '&gt;').replace('"', '&quot;'))


def generate_course_gpx(from_name, from_lat, from_lon, to_name, to_lat, to_lon, hazards):
    """Build a GPX string with the course route + hazard waypoints."""
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="AudioChart"',
        '     xmlns="http://www.topografix.com/GPX/1/1"',
        '     xmlns:opencpn="http://www.opencpn.org">',
    ]
    # Hazard waypoints (standalone markers on the chart)
    for h in hazards:
        name = _xml_escape((h.get('name') or h.get('label', 'hazard')).strip(', '))
        lines += [
            f'  <wpt lat="{h["lat"]:.6f}" lon="{h["lon"]:.6f}">',
            f'    <name>{name}</name>',
            '    <sym>circle</sym>',
            '    <extensions><opencpn:waypoint>',
            '      <opencpn:viz>1</opencpn:viz>',
            '      <opencpn:viz_name>1</opencpn:viz_name>',
            '    </opencpn:waypoint></extensions>',
            '  </wpt>',
        ]
    # Course route
    lines += [
        f'  <rte>',
        f'    <name>AudioChart: {_xml_escape(from_name)} to {_xml_escape(to_name)}</name>',
        f'    <rtept lat="{from_lat:.6f}" lon="{from_lon:.6f}">',
        f'      <name>{_xml_escape(from_name)}</name>',
        f'    </rtept>',
        f'    <rtept lat="{to_lat:.6f}" lon="{to_lon:.6f}">',
        f'      <name>{_xml_escape(to_name)}</name>',
        f'    </rtept>',
        f'  </rte>',
        '</gpx>',
    ]
    return '\n'.join(lines)


async def handle_opencpn_draw(request):
    """POST /api/opencpn-draw — write a GPX file and open it in OpenCPN."""
    import subprocess, os
    try:
        data = await request.json()
        gpx = generate_course_gpx(
            data.get('from_name', 'Start'), data['from_lat'], data['from_lon'],
            data.get('to_name', 'End'),   data['to_lat'],   data['to_lon'],
            data.get('hazards', []),
        )
        path = os.path.expanduser('~/Documents/audiochart_course.gpx')
        with open(path, 'w') as f:
            f.write(gpx)
        subprocess.Popen(['open', '-a', 'OpenCPN', path])
        return _json_response(request, {'ok': True, 'path': path, 'count': len(data.get('hazards', []))})
    except Exception as e:
        return web.Response(status=400, text=str(e))


async def handle_nearest_landmark(request):
    """GET /api/nearest-landmark?lat=…&lon=…  — best human-readable reference point."""
    try:
        lat = float(request.rel_url.query['lat'])
        lon = float(request.rel_url.query['lon'])
    except (KeyError, ValueError):
        return web.Response(status=400, text='lat and lon required')

    result = await asyncio.get_event_loop().run_in_executor(
        None, chartdb.find_nearest_landmark, lat, lon
    )
    if result is None:
        return web.Response(status=404, text='No landmark found')
    return _json_response(request, result)


async def handle_route_hazards(request):
    """GET /api/route-hazards?name=Ted+New+Rock+Route"""
    name = request.rel_url.query.get('name', '').strip()
    if not name:
        return web.Response(status=400, text='name required')
    route = await asyncio.get_event_loop().run_in_executor(
        None, opencpn_waypoints.get_route_by_name, name
    )
    if not route:
        return _json_response(request, {'not_found': True, 'name': name})
    waypoints = route['points']
    if len(waypoints) < 2:
        return _json_response(request, {'error': f'Route has fewer than 2 waypoints', 'route_name': route['name']})
    result = await asyncio.get_event_loop().run_in_executor(
        None, chartdb.get_route_segment_hazards, waypoints
    )
    result['route_name'] = route['name']
    result['from'] = {'lat': waypoints[0]['lat'],  'lon': waypoints[0]['lon'],  'name': waypoints[0]['name']  or 'Start'}
    result['to']   = {'lat': waypoints[-1]['lat'], 'lon': waypoints[-1]['lon'], 'name': waypoints[-1]['name'] or 'End'}
    result['waypoints'] = waypoints
    return _json_response(request, result)


async def handle_course_hazards(request):
    """GET /api/course-hazards?from_lat=&from_lon=&to_lat=&to_lon=&corridor=0.25"""
    try:
        from_lat = float(request.rel_url.query['from_lat'])
        from_lon = float(request.rel_url.query['from_lon'])
        to_lat   = float(request.rel_url.query['to_lat'])
        to_lon   = float(request.rel_url.query['to_lon'])
        corridor = float(request.rel_url.query.get('corridor', 0.25))
    except (KeyError, ValueError):
        return web.Response(status=400, text='from_lat, from_lon, to_lat, to_lon required')
    result = await asyncio.get_event_loop().run_in_executor(
        None, chartdb.get_course_hazards, from_lat, from_lon, to_lat, to_lon, corridor
    )
    return _json_response(request, result)


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
    app.router.add_get('/api/nearest-landmark', handle_nearest_landmark)
    app.router.add_get('/api/route-hazards', handle_route_hazards)
    app.router.add_get('/api/course-hazards', handle_course_hazards)
    app.router.add_get('/course-map', handle_course_map)
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
