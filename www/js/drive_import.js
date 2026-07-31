/**
 * Import a single file the user picks from their own Google Drive (e.g. a
 * GPX route they saved there from Navionics' share sheet) — separate concern
 * from drive_sync.js's routes/tracks backup, but shares its cached OAuth
 * token so the user only consents once. Nothing here runs until the user
 * taps "Import from Drive"; the offline-first core of the app never loads
 * this file's scripts.
 */

import { ensureAccessToken, clearAccessToken, PICKER_API_KEY } from './drive_sync.js';

const CLIENT_ID = '211452396461-9bilt4qfu063r4pup4an5gu5n47h9kfb.apps.googleusercontent.com';

let pickerLoadPromise = null;

function _ensurePickerLoaded() {
  if (window.google?.picker) return Promise.resolve();
  if (pickerLoadPromise) return pickerLoadPromise;
  pickerLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.onload = () => {
      gapi.load('picker', { callback: resolve, onerror: () => { pickerLoadPromise = null; reject(new Error('Could not reach Google (offline?)')); } });
    };
    script.onerror = () => { pickerLoadPromise = null; reject(new Error('Could not reach Google (offline?)')); };
    document.head.appendChild(script);
  });
  return pickerLoadPromise;
}

function _fetchFileText(fileId, token) {
  return fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(res => {
    if (res.status === 401) clearAccessToken();
    if (!res.ok) throw new Error(`Drive API error ${res.status}`);
    return res.text();
  });
}

/**
 * Opens the Google Picker for the user to choose a file from their Drive.
 * Calls onGpxText(text, filename) once a file is picked and fetched.
 * Resolves (without calling onGpxText) if the user cancels; rejects on
 * network/auth failure.
 */
export function openDriveImportPicker(onGpxText) {
  if (!navigator.onLine) return Promise.reject(new Error('Offline — cannot open Drive right now.'));

  return Promise.all([_ensurePickerLoaded(), ensureAccessToken()]).then(([, token]) => {
    return new Promise((resolve, reject) => {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false);

      const picker = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(PICKER_API_KEY)
        .setAppId(CLIENT_ID.split('-')[0])
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            const doc = data.docs[0];
            _fetchFileText(doc.id, token)
              .then(text => { onGpxText(text, doc.name); resolve(); })
              .catch(reject);
          } else if (data.action === google.picker.Action.CANCEL) {
            resolve();
          }
        })
        .build();
      picker.setVisible(true);
    });
  });
}
