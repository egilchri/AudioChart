/**
 * Optional Google Drive backup for saved Routes/Tracks — a true merge, not a
 * one-way push/pull. Every sync reconciles local and remote (see
 * sync_merge.js for the algorithm) so you never have to know or guess which
 * side is "right"; the empty-local-vs-populated-remote case that once wiped
 * a real backup now just self-heals. localStorage remains fully functional
 * offline regardless of Drive auth/connectivity state — Google's auth
 * script only loads the first time a sync actually runs.
 */

import { mergeCollections, pruneTombstones } from './sync_merge.js';

const CLIENT_ID = '211452396461-9bilt4qfu063r4pup4an5gu5n47h9kfb.apps.googleusercontent.com';
// drive.appdata backs the routes/tracks JSON blob below (hidden, app-private).
// drive.file backs drive_import.js's "Import from Drive" Picker (user-visible
// files the user explicitly picks) — both are non-sensitive scopes, so
// requesting them together still needs no Google app verification.
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
// Public, referrer-restricted key for the Google Picker widget (not a secret;
// restrict it in Google Cloud Console to this app's origin + Picker API only).
export const PICKER_API_KEY = 'AIzaSyCFLws631M1uoiP-cZmwinduPyuqhgiU2E';
const DRIVE_FILE_NAME = 'audiochart-routes-tracks.json';
const ROUTE_KEY = 'audiochart-user-routes';
const TRACK_KEY = 'audiochart-user-tracks';
const TOMBSTONE_KEY = 'audiochart-sync-tombstones';
const WIFI_TOGGLE_KEY = 'audiochart-drive-wifi-sync';
const LAST_SYNC_KEY = 'audiochart-drive-last-sync';
const AUTO_SYNC_MIN_INTERVAL_MS = 60000;

let tokenClient = null;
let accessToken = null;
let gisLoadPromise = null;
let fileId = null;
let _autoSyncing = false;

export function getWifiSyncEnabled() {
  return localStorage.getItem(WIFI_TOGGLE_KEY) === '1';
}

export function setWifiSyncEnabled(on) {
  localStorage.setItem(WIFI_TOGGLE_KEY, on ? '1' : '0');
}

export function getLastSyncMs() {
  return parseInt(localStorage.getItem(LAST_SYNC_KEY) || '0', 10);
}

function _ensureGisLoaded() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { gisLoadPromise = null; reject(new Error('Could not reach Google (offline?)')); };
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

// Shared with drive_import.js so both Drive features reuse one cached token
// (one consent prompt covering both scopes) instead of each requesting its own.
export function ensureAccessToken() {
  return _ensureToken();
}

export function clearAccessToken() {
  accessToken = null;
}

function _ensureToken() {
  return _ensureGisLoaded().then(() => new Promise((resolve, reject) => {
    if (accessToken) { resolve(accessToken); return; }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: () => {},
      });
    }
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error(resp.error)); return; }
      accessToken = resp.access_token;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  }));
}

function _apiFetch(url, opts = {}) {
  return _ensureToken().then(token => fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  })).then(res => {
    if (res.status === 401) accessToken = null;
    if (!res.ok) throw new Error(`Drive API error ${res.status}`);
    return res;
  });
}

function _findFileId() {
  if (fileId) return Promise.resolve(fileId);
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}'`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name)`;
  return _apiFetch(url).then(res => res.json()).then(data => {
    fileId = (data.files && data.files[0] && data.files[0].id) || null;
    return fileId;
  });
}

function _fetchRemote() {
  return _findFileId().then(id => {
    if (!id) return { routes: [], tracks: [], tombstones: [] };
    return _apiFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`).then(res => res.json());
  });
}

function _writeRemote(payload) {
  const body = JSON.stringify(payload);
  return _findFileId().then(id => {
    if (id) {
      return _apiFetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    }
    const metadata = { name: DRIVE_FILE_NAME, parents: ['appDataFolder'] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([body], { type: 'application/json' }));
    return _apiFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      body: form,
    }).then(res => res.json()).then(data => { fileId = data.id; });
  });
}

/**
 * Merge local and remote Routes/Tracks, write the reconciled result back to
 * both sides. Resolves to a summary for the status UI.
 */
export function runMerge() {
  if (!navigator.onLine) return Promise.reject(new Error('Offline — cannot sync right now.'));

  const localRoutes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const localTracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
  const localTombstones = JSON.parse(localStorage.getItem(TOMBSTONE_KEY) || '[]');
  const localRouteTombstones = localTombstones.filter(t => t.type === 'route');
  const localTrackTombstones = localTombstones.filter(t => t.type === 'track');

  return _fetchRemote().then(remote => {
    const remoteTombstones = remote.tombstones || [];
    const remoteRouteTombstones = remoteTombstones.filter(t => t.type === 'route');
    const remoteTrackTombstones = remoteTombstones.filter(t => t.type === 'track');

    const routeResult = mergeCollections({
      localItems: localRoutes, remoteItems: remote.routes || [],
      localTombstones: localRouteTombstones, remoteTombstones: remoteRouteTombstones,
    });
    const trackResult = mergeCollections({
      localItems: localTracks, remoteItems: remote.tracks || [],
      localTombstones: localTrackTombstones, remoteTombstones: remoteTrackTombstones,
    });
    const mergedTombstones = pruneTombstones(
      [...routeResult.tombstones, ...trackResult.tombstones],
      { maxCount: 2000 }
    );

    localStorage.setItem(ROUTE_KEY, JSON.stringify(routeResult.merged));
    localStorage.setItem(TRACK_KEY, JSON.stringify(trackResult.merged));
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(mergedTombstones));

    return _writeRemote({
      routes: routeResult.merged,
      tracks: trackResult.merged,
      tombstones: mergedTombstones,
      savedAt: Date.now(),
    }).then(() => {
      localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
      return {
        routeCount: routeResult.merged.length,
        trackCount: trackResult.merged.length,
        conflictCount: routeResult.conflictCount + trackResult.conflictCount,
      };
    });
  });
}

/** Called opportunistically (e.g. on panel open) — silently no-ops unless Wi-Fi Sync is on and it's been a while. */
export function maybeAutoSync() {
  if (!getWifiSyncEnabled() || _autoSyncing) return;
  if (Date.now() - getLastSyncMs() < AUTO_SYNC_MIN_INTERVAL_MS) return;
  _autoSyncing = true;
  runMerge().catch(() => {}).finally(() => { _autoSyncing = false; });
}
