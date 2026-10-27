// Syncs the local data with a private GitHub repo through the Contents API.
// Local-first: the app always reads and writes localStorage. This module merges per record
// (newest `upd` wins) and pushes the difference. One file per month keeps requests few and files small:
//   days/YYYY-MM.json  { version, days:  { "YYYY-MM-DD": day } }
//   foods.json         { version, foods: { key: product } }

const API = 'https://api.github.com';
export const DEFAULT_REPO = 'grabowskirobert/food-tracker-data';
const DAY_MS = 864e5;
const DELAY_MS = 30000;

export class SyncError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// UTF-8 safe base64 (btoa alone breaks on Polish letters).
const b64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// Merges two { key: record } maps. The newest `upd` wins; equal stamps change nothing.
export function mergeMaps(local, remote) {
  const merged = { ...local }, toLocal = [], toRemote = [];
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[k], r = remote[k];
    if (!r) toRemote.push(k);
    else if (!l || (r.upd || 0) > (l.upd || 0)) { merged[k] = r; toLocal.push(k); }
    else if ((l.upd || 0) > (r.upd || 0)) toRemote.push(k);
  }
  return { merged, toLocal, toRemote };
}

// store: { get, set, keys(prefix) } over localStorage.
// focusMonths(): months to pull on every full sync. onStatus(): redraw. onRemote({ days, foods }): data changed.
export function createSync({ store, focusMonths, onStatus, onRemote }) {
  let running = null, again = null, timer = null;

  const cfg = () => ({ token: store.get('ghtoken', ''), repo: store.get('ghrepo', '') || DEFAULT_REPO });
  const dirtyState = () => store.get('dirty', { m: {}, foods: 0 });

  async function gh(url, init = {}) {
    const { token } = cfg();
    let res;
    try {
      res = await fetch(API + url, {
        ...init,
        cache: 'no-store', // GitHub answers GETs with max-age=60; a cached copy would hide the other device's changes
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch {
      throw new SyncError('net', 'Brak połączenia z GitHubem.');
    }
    if (res.status === 401) throw new SyncError('auth', 'Token GitHub jest nieprawidłowy albo wygasł.');
    if (res.status === 403) {
      const limited = res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
      throw limited
        ? new SyncError('rate', 'Limit zapytań GitHuba. Spróbuję ponownie później.')
        : new SyncError('access', 'Token nie ma zapisu do tego repo (potrzebne: Contents, Read and write).');
    }
    return res;
  }

  const file = (path) => `/repos/${cfg().repo}/contents/${path}`;

  async function getFile(path) {
    const res = await gh(file(path));
    // A repo without any commit answers 409 instead of 404; either way the file does not exist yet.
    if (res.status === 404 || res.status === 409) return null;
    if (!res.ok) throw new SyncError('other', `GitHub ${res.status} przy odczycie ${path}.`);
    const f = await res.json();
    if (f.encoding !== 'base64') throw new SyncError('other', `Plik ${path} jest za duży do odczytu.`);
    return { data: JSON.parse(unb64(f.content)), sha: f.sha };
  }

  async function putFile(path, data, sha, message) {
    const res = await gh(file(path), {
      method: 'PUT',
      body: JSON.stringify({ message, content: b64(JSON.stringify(data, null, 1) + '\n'), ...(sha ? { sha } : {}) }),
    });
    if (res.status === 409 || res.status === 422) throw new SyncError('conflict', 'Konflikt zapisu, spróbuję ponownie przy następnej synchronizacji.');
    if (!res.ok) throw new SyncError('other', `GitHub ${res.status} przy zapisie ${path}.`);
  }

  // Pulls one remote file, merges it with the local map and pushes what the remote lacks.
  // A write conflict (the other device pushed meanwhile) re-reads and merges once more.
  async function syncMap({ path, field, readLocal, writeLocal, message }) {
    for (let attempt = 0; ; attempt++) {
      const remote = await getFile(path);
      const { merged, toLocal, toRemote } = mergeMaps(readLocal(), remote?.data?.[field] || {});
      if (toLocal.length) writeLocal(toLocal.map((k) => [k, merged[k]]));
      if (toRemote.length) {
        try {
          await putFile(path, { version: 1, [field]: sortKeys(merged) }, remote?.sha, message(toRemote.length));
        } catch (e) {
          if (e.code === 'conflict' && attempt === 0) continue;
          throw e;
        }
      }
      return toLocal;
    }
  }

  const localMonths = () => [...new Set(store.keys('day:').map((k) => k.slice(4, 11)))];

  async function run({ full }) {
    if (!cfg().token) return;
    const prev = store.get('sync', {});
    // A fine-grained token answers 404 for a repo it cannot see; tell that apart from a missing file.
    if (!prev.ok || prev.err) {
      const res = await gh(`/repos/${cfg().repo}`);
      if (res.status === 404) throw new SyncError('access', 'Nie znaleziono repo albo token nie ma do niego dostępu.');
    }
    const snap = dirtyState();
    const synced = store.get('synced', {});
    const months = new Set([...Object.keys(snap.m), ...localMonths().filter((m) => !synced[m])]);
    if (full) focusMonths().forEach((m) => months.add(m));
    const changed = { days: [], foods: false };

    for (const m of [...months].sort()) {
      const pulled = await syncMap({
        path: `days/${m}.json`,
        field: 'days',
        readLocal: () => Object.fromEntries(store.keys(`day:${m}-`).map((k) => [k.slice(4), store.get(k, null)])),
        writeLocal: (pairs) => pairs.forEach(([k, rec]) => store.set('day:' + k, rec)),
        message: (n) => `food-tracker ${m}: ${n} ${n === 1 ? 'dzień' : 'dni'}`,
      });
      changed.days.push(...pulled);
      store.set('synced', { ...store.get('synced', {}), [m]: true });
      const d = dirtyState();
      if (d.m[m] === snap.m[m]) { delete d.m[m]; store.set('dirty', d); }
    }

    if (full || snap.foods || !synced.foods) {
      const pulled = await syncMap({
        path: 'foods.json',
        field: 'foods',
        readLocal: () => store.get('foods', {}),
        writeLocal: (pairs) => store.set('foods', { ...store.get('foods', {}), ...Object.fromEntries(pairs) }),
        message: (n) => `food-tracker produkty: ${n}`,
      });
      changed.foods = pulled.length > 0;
      store.set('synced', { ...store.get('synced', {}), foods: true });
      const d = dirtyState();
      if (d.foods === snap.foods) { d.foods = 0; store.set('dirty', d); }
    }
    store.set('sync', { ok: Date.now(), err: '' });
    if (changed.days.length || changed.foods) onRemote(changed);
  }

  // Runs one sync; calls made while one is running are folded into a single follow-up run.
  function start({ full = false } = {}) {
    if (!cfg().token) return Promise.resolve();
    clearTimeout(timer);
    if (running) { again = { full: full || again?.full }; return running; }
    running = (async () => {
      await null; // let `running` be assigned before anything reads the status
      try {
        await run({ full });
      } catch (e) {
        store.set('sync', { ...store.get('sync', {}), err: e.message || String(e), code: e.code || 'other' });
      } finally {
        running = null;
        onStatus();
        if (again) { const a = again; again = null; start(a); }
      }
    })();
    onStatus();
    return running;
  }

  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => start(), DELAY_MS); };
  const bump = (patch) => { const d = dirtyState(); patch(d); store.set('dirty', d); onStatus(); schedule(); };

  return {
    start,
    dirtyDay: (dayKey) => bump((d) => { const m = dayKey.slice(0, 7); d.m[m] = (d.m[m] || 0) + 1; }),
    dirtyFoods: () => bump((d) => { d.foods = (d.foods || 0) + 1; }),
    // Leaving the app: push at once instead of waiting out the delay (iOS may still cut it short).
    flush() {
      const d = dirtyState();
      if (Object.keys(d.m).length || d.foods) start();
    },
    resetSynced() { store.set('synced', {}); store.set('sync', {}); },
    status() {
      const { token } = cfg();
      const st = store.get('sync', {});
      const d = dirtyState();
      const dirty = Object.keys(d.m).length + (d.foods ? 1 : 0);
      const age = st.ok ? Date.now() - st.ok : Infinity;
      let state;
      if (!token) state = 'off';
      else if (running) state = 'busy';
      else if (!st.ok) state = st.err ? 'bad' : 'pending';
      else if (age > DAY_MS) state = 'bad';
      else state = dirty ? 'pending' : 'ok';
      return { state, last: st.ok || 0, err: st.err || '', code: st.code || '', dirty, staleDays: st.ok ? Math.floor(age / DAY_MS) : null };
    },
  };
}
