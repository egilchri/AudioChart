/**
 * Optional Google Drive backup for saved Routes/Tracks.
 * Sync is always user-initiated or gated behind the "Wi-Fi Sync" toggle —
 * localStorage remains the source of truth so the app keeps working fully
 * offline regardless of Drive auth/connectivity state.
 */

const CLIENT_ID = '211452396461-9bilt4qfu063r4pup4an5gu5n47h9kfb.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE_NAME = 'audiochart-routes-tracks.json';
const ROUTE_KEY = 'audiochart-user-routes';
const TRACK_KEY = 'audiochart-user-tracks';
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

function _localSnapshot() {
  return {
    routes: JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]'),
    tracks: JSON.parse(localStorage.getItem(TRACK_KEY) || '[]'),
    savedAt: Date.now(),
  };
}

export function syncNow() {
  if (!navigator.onLine) return Promise.reject(new Error('Offline — cannot sync right now.'));
  const body = JSON.stringify(_localSnapshot());
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
  }).then(() => {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  });
}

/** Called opportunistically (e.g. on panel open) — silently no-ops unless Wi-Fi Sync is on and it's been a while. */
export function maybeAutoSync() {
  if (!getWifiSyncEnabled() || _autoSyncing) return;
  if (Date.now() - getLastSyncMs() < AUTO_SYNC_MIN_INTERVAL_MS) return;
  _autoSyncing = true;
  syncNow().catch(() => {}).finally(() => { _autoSyncing = false; });
}

/** Resolves to {routes, tracks, savedAt} or null if no backup exists yet on Drive. */
export function fetchBackup() {
  if (!navigator.onLine) return Promise.reject(new Error('Offline — cannot restore right now.'));
  return _findFileId().then(id => {
    if (!id) return null;
    return _apiFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`).then(res => res.json());
  });
}

export function applyBackup(data) {
  localStorage.setItem(ROUTE_KEY, JSON.stringify(data.routes || []));
  localStorage.setItem(TRACK_KEY, JSON.stringify(data.tracks || []));
  localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
}
