# AudioChart — Startup Guide

## What it does

AudioChart is a nautical safety tool for sailing Penobscot Bay. It answers text queries (use your phone keyboard's mic button to speak them) like:

- *"Hazards within quarter mile"*
- *"Range and bearing to Carvers Harbor"*
- *"Range and bearing to Ted Special Mark"* (your OpenCPN waypoints)
- *"Range and bearing to 44° 06.1' N 069° 04.5' W"*
- *"Nearest hazard"*
- *"Where am I"*

Bearings are **magnetic**. Position comes from OpenCPN if it is running, otherwise from the phone's built-in GPS.

---

## Before you leave the dock

### 1. Start the server (Mac)

Open a terminal, navigate to the project, and run:

```bash
cd /Users/edgargilchrist/tools/AudioChart
python3 server/server.py
```

The server will print something like:

```
AudioChart server running.
  Local:    http://localhost:8080
  Network:  http://192.168.40.213:8080
  Bonjour:  http://edgars-macbook-pro.local:8080
  NMEA out: localhost:10112  (add to OpenCPN as TCP Input for test-position)

To connect your phone — open this on your Mac:
  http://localhost:8080/connect
Then scan the QR code with your phone camera.

[chartdb] Found 185 ENC charts — processing any new ones...
[opencpn] Polling opencpn.ini for OwnShipLatLon every 2s
```

Leave this terminal open. The server processes ENC charts in the background on first run (takes about 30 seconds). Subsequent starts skip already-processed charts and are nearly instant.

### 2. Open the app on your Android phone

1. Make sure your phone is on the same network as the Mac (connect phone to Mac's hotspot, or connect Mac to phone's hotspot — no internet required, just a local network).
2. On your **Mac**, open `http://localhost:8080/connect` in any browser — you'll see a QR code.
3. Point your **phone camera** at the QR code and tap the link to open the app in Chrome.
4. Tap the **"Add to Home Screen"** option in Chrome's menu to install it as a home screen app.

> **No camera?** The network URL (e.g. `http://192.168.40.213:8080`) is printed by the server and shown below the QR code.

### 3. Prepare offline data (do this before every voyage)

Tap the **⬇ Route** button in the header. A picker appears with available cruise profiles — tap one to start downloading. The status line shows progress (`Downloading Camden (2 of 6)…`) and a final total when complete.

Each stop downloads a 25nm radius. Overlapping circles give continuous corridor coverage across the whole route.

| Cruise | Stops |
|---|---|
| Penobscot Bay | Rockland, Camden, Belfast, Castine, Stonington, Great Cranberry Island |
| Casco Bay | Portland, Harpswell |

After this, the phone can run the app **without the Mac** for the entire voyage.

**Downloading just one area?** Use **⬇ Offline** instead — it downloads a 25nm radius around your current GPS position only.

**Adding a new area mid-voyage?** Connect the phone back to the Mac server, tap **⬇ Offline** from your new position, and it merges into the existing cache without erasing anything.

### 4. Test before departure

With OpenCPN running, try these queries to confirm everything works:

- *"Where am I"* — should read back your position at the Rockland breakwater
- *"Hazards within quarter mile"* — should list nearby rocks/shoals
- *"Range and bearing to Carvers Harbor"* — should give a bearing and distance

---

## Underway

### Operating modes

| Situation | What happens |
|---|---|
| Mac running below decks, phone on same network | Dynamic chart data for any area, live OpenCPN position and waypoints |
| Phone only (no Mac) | Offline mode — uses data downloaded at dock, phone GPS |

### GPS source priority (shown in the badge)

| Badge | Source |
|---|---|
| `TEST POSITION` | Manual override — you set the position for testing (amber) |
| `OPENCPN LIVE` | Real-time NMEA from OpenCPN TCP output |
| `GPS PUCK` | USB GPS puck via Mac serial bridge |
| `OPENCPN` | OpenCPN's last known position (polled from config) |
| `OPENCPN TRACK` | OpenCPN's last recorded track point |
| `PHONE GPS` | Android device GPS (fallback) |

### Entering commands

Type in the text box and press Enter or ▶. On your Pixel, tap the **mic icon on the keyboard** to dictate — it fills the text box and you press Enter to submit. No app-level microphone permission needed.

Previous queries are saved as pills below the text box — tap any pill to rerun it instantly. Tap **✕** to clear history.

### OpenCPN waypoints

Any named mark you drop in OpenCPN appears in AudioChart within **30 seconds** automatically when connected to the Mac server, or is available offline if you tapped **⬇ Offline** at dock. Ask for it by name:

> *"Range and bearing to [your waypoint name]"*

Waypoint responses are labeled *(waypoint)* to distinguish them from chart features.

---

## Testing with a fake position

Tap **📍** in the header to open the test position input. You can enter:

- A place name: `Southwest Harbor`, `Camden`, `Stonington`
- Decimal degrees: `44.1018, -69.0752`
- Degrees-minutes: `44° 06.1' N 069° 04.5' W`

Tap **Set** — the GPS badge turns amber **TEST POSITION** and all queries use that location. A **View on map** link appears below the position display — tap it to open the coordinates in Google Maps to visually confirm the spot.

Tap **📍 → Clear** to return to real GPS.

---

## Stopping the server

Press **Ctrl+C** in the terminal where `server.py` is running.

---

## Restarting

Just run `python3 server/server.py` again. Then press **⌘R** in Chrome to reload the app.

---

## Enabling real-time OpenCPN position (optional)

By default, AudioChart polls OpenCPN's config file for position every 2 seconds. For real-time GPS from OpenCPN:

1. In OpenCPN: **Options → Connections → Add Connection**
2. Set: Type **Network** | Protocol **TCP** | Address **localhost** | Port **10110** | Direction **Output only**

The badge will change from `OPENCPN` to `OPENCPN LIVE`.

---

## Showing test positions in OpenCPN (one-time setup)

When you set a test position in AudioChart (📍), the Mac server broadcasts fake NMEA on port **10112**. To see the ship icon move in OpenCPN:

1. In OpenCPN: **Options → Connections → Add Connection**
2. Set: Type **Network** | Protocol **TCP** | Address **localhost** | Port **10112** | Direction **Input**

After this, tapping 📍 → Set in AudioChart moves the OpenCPN ship icon to your test position within one second. Tapping Clear stops the broadcast.

On your **phone**, a **View on map** link appears below the position display whenever a test position is active — tap it to open the coordinates in Google Maps (or any map app).

---

## Chart coverage

Charts are loaded dynamically based on your position. As you navigate to new areas, AudioChart automatically serves data for your current location from the full ENC library at:

```
~/Documents/Charts/ENC/US_ME/
```

The processed chart database is stored at `server/charts.db`. Delete this file to force a full reprocess.

---

## File locations

| File | Purpose |
|---|---|
| `server/server.py` | Main server — run this |
| `server/charts.db` | Processed ENC database (auto-generated) |
| `www/` | The web app (served by the server) |
| `preprocess/charts.yaml` | Chart regions for static preprocessing |
| `~/Library/Preferences/opencpn/opencpn.ini` | OpenCPN config (read for position + MAGVAR) |
| `~/Library/Preferences/opencpn/navobj.db` | OpenCPN waypoints (polled every 30s) |
