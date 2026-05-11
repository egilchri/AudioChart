# AudioChart — Startup Guide

## What it does

AudioChart is a speech-enabled nautical safety tool for sailing Penobscot Bay. It answers voice or text queries like:

- *"Hazards within quarter mile"*
- *"Range and bearing to Carvers Harbor"*
- *"Range and bearing to Ted Special Mark"* (your OpenCPN waypoints)
- *"Range and bearing to 44° 06.1' N 069° 04.5' W"*
- *"Nearest hazard"*
- *"Where am I"*

Bearings are **magnetic**. Position comes from OpenCPN if it is running, otherwise from the device's built-in GPS.

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

[chartdb] Found 185 ENC charts — processing any new ones...
[opencpn] Polling opencpn.ini for OwnShipLatLon every 2s
```

Leave this terminal open. The server processes ENC charts in the background on first run (takes about 30 seconds). Subsequent starts skip already-processed charts and are nearly instant.

### 2. Open the app on your Android phone

1. Make sure your phone is on the same network as the Mac (connect phone to Mac's hotspot, or connect Mac to phone's hotspot — no internet required, just a local network).
2. Open **Chrome** on the phone and visit `http://192.168.40.213:8080` (use the IP printed by the server).
3. Tap the **"Add to Home Screen"** option in Chrome's menu to install it as a home screen app.

### 3. Set up offline speech recognition (one time only)

On your Android phone:

> **Settings → General Management → Language → Text-to-speech → Offline speech recognition → download English (United States)**

This allows voice queries to work without cell service.

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
| Mac running below decks, phone on same network | Full tile charts, OpenCPN position, live waypoints |
| Phone only (no Mac) | Offline mode — cached chart data and phone GPS |

### GPS source priority (shown in the badge)

| Badge | Source |
|---|---|
| `OPENCPN LIVE` | Real-time NMEA from OpenCPN TCP output |
| `GPS PUCK` | USB GPS puck via Mac serial bridge |
| `OPENCPN` | OpenCPN's last known position (polled from config) |
| `OPENCPN TRACK` | OpenCPN's last recorded track point |
| `PHONE GPS` | Android device GPS (fallback) |

### Voice commands

Press and **hold the microphone button**, speak your query, then release. Or type in the text box and press Enter or ▶.

Previous queries are saved as pills below the text input — tap any pill to rerun it. Tap **✕** to clear history.

### OpenCPN waypoints

Any named mark you drop in OpenCPN appears in AudioChart within **30 seconds** automatically. Ask for it by name:

> *"Range and bearing to [your waypoint name]"*

Waypoint responses are labeled *(waypoint)* to distinguish them from chart features.

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
