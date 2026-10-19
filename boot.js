// Safety net for a half-loaded app. If a script fails to load or the app throws while starting (a stale
// file from an earlier version, a dropped connection), the page would stay an empty shell until the
// app is closed and opened again. Instead: drop the service worker and its caches and reload once.
// app.js sets __ftReady when it has drawn the first screen; after that nothing here acts.
(() => {
  const KEY = 'ft:heal';
  let healing = false;
  async function heal() {
    if (healing || window.__ftReady) return;
    healing = true;
    let tries = 0;
    try { tries = +sessionStorage.getItem(KEY) || 0; } catch {}
    if (tries >= 1) return; // already reloaded once in this session: don't loop
    try { sessionStorage.setItem(KEY, String(tries + 1)); } catch {}
    try {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      for (const k of await caches.keys()) await caches.delete(k);
    } catch {}
    location.reload();
  }
  // Capture phase: a failed <script> reports on the element, which does not bubble to window.
  addEventListener('error', (e) => {
    if (e.target instanceof HTMLScriptElement || !e.target?.nodeType) heal();
  }, true);
  setTimeout(heal, 8000);
})();
