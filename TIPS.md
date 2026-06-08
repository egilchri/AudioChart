# AudioChart — Tips & Tricks

## PWA won't update to the new version

**Symptom:** You bump the version in `version.js` and `sw.js`, but the installed PWA keeps showing the old version number after reloading. Rebooting the Mac doesn't help.

**Why it happens:** The PWA is installed from GitHub Pages (`https://egilchri.github.io/AudioChart`). Its service worker caches all JS/CSS/HTML aggressively. Until a new `sw.js` is deployed to Pages, every reload just reactivates the old service worker and serves old cached files — even if your local working tree is already at the new version.

**Fix (in order of effort):**

1. **Commit and push first.** The service worker on Pages only changes when a new `sw.js` is pushed and GitHub Actions deploys it (~1 minute).

   ```bash
   git add www/js/app.js www/js/parser.js www/js/query.js www/js/version.js www/sw.js
   git commit -m "..."
   git push
   ```

2. **Hard reload** in the PWA after the deploy finishes: **Shift-CMD-R**. This bypasses the browser cache and lets the new service worker install.

3. **If Shift-CMD-R doesn't take:** Open Chrome DevTools → **Application → Storage → Clear site data** (all boxes checked), then reload. This unregisters the old service worker and wipes the cache.

4. **Nuclear option — uninstall the PWA.** Remove it from the dock/home screen, wait for the deploy to finish, then reinstall from `https://egilchri.github.io/AudioChart`. Guarantees a clean slate.

**Rule of thumb:** Every time you bump the version, push immediately. Don't leave new version numbers sitting in the working tree — the PWA can't see them until they're on Pages.
