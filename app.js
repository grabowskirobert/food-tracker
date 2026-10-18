import { FOODS, PLANS, TARGETS } from './data.js';
import { analyze, friendlyError, MODELS } from './llm.js';

const $ = (s) => document.querySelector(s);
const NUT = ['k', 'p', 'f', 's', 'b'];

// --- storage: everything lives in localStorage under "ft:" ---------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem('ft:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ft:' + k, JSON.stringify(v)); } catch { toast('Nie udało się zapisać danych.'); } },
  del(k) { try { localStorage.removeItem('ft:' + k); } catch {} },
};
navigator.storage?.persist?.();

const pad = (n) => String(n).padStart(2, '0');
// Local date, not toISOString(): that is UTC and would file late-evening meals under the wrong day.
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const noon = (d) => { const x = new Date(d); x.setHours(12, 0, 0, 0); return x; };
const fmt = (x, d = 0) => (Math.round(x * 10 ** d) / 10 ** d).toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : 0; };

let cur = noon(new Date());
let day;

function loadDay() {
  day = store.get('day:' + keyOf(cur), null) || { plan: store.get('lastPlan', 'A'), over: {}, skip: {}, items: [] };
}
function saveDay() {
  store.set('day:' + keyOf(cur), day);
  store.set('lastPlan', day.plan);
}

function customFoods() { return store.get('foods', {}); }
function library() {
  const lib = {};
  for (const f of Object.values(FOODS)) lib[f.n.toLowerCase()] = f;
  return Object.assign(lib, customFoods());
}
function remember(f) {
  const foods = customFoods();
  const { n, k, p, f: fat, s, b, vf, url = '', src = '' } = f;
  foods[n.toLowerCase()] = { n, k, p, f: fat, s, b, vf, url, src };
  store.set('foods', foods);
}

// --- nutrition -------------------------------------------------------------------
function nutr(f, g) {
  const v = { vf: f.vf ? g : 0 };
  for (const c of NUT) v[c] = (f[c] || 0) * g / 100;
  return v;
}
function addTo(t, v) { for (const c of [...NUT, 'vf']) t[c] += v[c]; }
const zero = () => ({ k: 0, p: 0, f: 0, s: 0, b: 0, vf: 0 });

const plan = () => PLANS[day.plan];
const gramsOf = (mi, ii, g0) => day.over[`${day.plan}:${mi}:${ii}`] ?? g0;
const skipped = (mi) => !!day.skip[`${day.plan}:${mi}`];

function totals() {
  const t = zero();
  plan()?.meals.forEach((m, mi) => {
    if (skipped(mi)) return;
    m.items.forEach(([id, g0], ii) => addTo(t, nutr(FOODS[id], gramsOf(mi, ii, g0))));
  });
  day.items.forEach((it) => addTo(t, nutr(it, it.g)));
  return t;
}

const satPct = (t) => (t.k ? t.s * 9 / t.k * 100 : 0);
// 7% of the middle of the kcal range, in grams (2400 kcal → 19 g).
const SAT_BUDGET = Math.round(TARGETS.satpct[0] / 100 * (TARGETS.kcal[0] + TARGETS.kcal[1]) / 2 / 9);

const METRICS = [
  { label: 'Białko', unit: 'g', val: (t) => t.p, kind: 'min', lo: TARGETS.protein[0] },
  // The % limit applies to the whole day: early on one food's own share would show (an egg alone is ~20%),
  // so the bar tracks grams against the day's budget and the % only counts once the day reaches the kcal target.
  { label: 'Nasycone', unit: 'g', val: (t) => t.s, kind: 'max', hi: SAT_BUDGET,
    bad: (t) => t.s >= SAT_BUDGET || (t.k >= TARGETS.kcal[0] && satPct(t) >= TARGETS.satpct[0]),
    dec: 1, extra: (t) => (t.k >= TARGETS.kcal[0] ? `${fmt(satPct(t), 1)}% kcal` : null) },
  { label: 'Błonnik', unit: 'g', val: (t) => t.b, kind: 'min', lo: TARGETS.fibre[0] },
  { label: 'Warzywa i owoce', unit: 'g', val: (t) => t.vf, kind: 'min', lo: TARGETS.vf[0] },
];

// --- tiny DOM helper (textContent only, so nothing from the web is parsed as HTML) --
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function gramInput(value, onChange, label) {
  return h('input', {
    type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: String(value), class: 'g',
    'aria-label': label, onfocus: (e) => e.target.select(),
    oninput: (e) => onChange(num(e.target.value)),
  });
}

// --- rendering -------------------------------------------------------------------
let rowRefs = [];

function render() {
  for (const b of $('#seg').children) b.setAttribute('aria-checked', String(b.dataset.plan === day.plan));
  renderDate();
  renderMeals();
  renderItems();
  refresh();
}

function renderDate() {
  const today = noon(new Date());
  const diff = Math.round((today - cur) / 864e5);
  $('#dlabel').textContent = diff === 0 ? 'Dziś' : diff === 1 ? 'Wczoraj' : cur.toLocaleDateString('pl-PL', { weekday: 'long' });
  $('#dsub').textContent = cur.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' });
  $('#next').disabled = diff <= 0;
}

function renderMeals() {
  rowRefs = [];
  const box = $('#meals');
  box.replaceChildren();
  const p = plan();
  if (!p) return;
  p.meals.forEach((m, mi) => {
    const off = skipped(mi);
    const kEl = h('span', { class: 'mk' });
    const card = h('article', { class: 'card meal' + (off ? ' off' : '') },
      h('header', {},
        h('h3', {}, m.name), kEl,
        h('button', {
          type: 'button', class: 'chip', 'aria-pressed': String(off),
          onclick: () => { const k = `${day.plan}:${mi}`; if (off) delete day.skip[k]; else day.skip[k] = true; saveDay(); render(); },
        }, off ? 'Przywróć' : 'Pomiń')),
      h('ul', { class: 'rows' }, m.items.map(([id, g0], ii) => {
        const f = FOODS[id];
        const rk = h('span', { class: 'rk' });
        rowRefs.push({ f, mi, rk, g: () => gramsOf(mi, ii, g0), meal: kEl });
        return h('li', {},
          h('span', { class: 'nm' }, f.n),
          h('label', { class: 'gw' }, gramInput(gramsOf(mi, ii, g0), (g) => {
            const k = `${day.plan}:${mi}:${ii}`;
            if (g === g0) delete day.over[k]; else day.over[k] = g;
            saveDay(); refresh();
          }, 'gramy: ' + f.n), h('span', {}, 'g')),
          rk);
      })));
    box.append(card);
  });
}

function itemRow(it, { onGrams, onDelete }) {
  const rk = h('span', { class: 'rk' });
  const meta = h('small', { class: 'meta' });
  const upd = () => {
    const v = nutr(it, it.g);
    rk.textContent = fmt(v.k);
    meta.replaceChildren(`B ${fmt(v.p, 1)} · T ${fmt(v.f, 1)} · nas. ${fmt(v.s, 1)} · bł. ${fmt(v.b, 1)}`);
    if (it.url && /^https?:\/\//.test(it.url)) meta.append(' · ', h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, it.src || 'źródło'));
    else if (it.src && it.src !== 'szacunek') meta.append(' · ', it.src);
  };
  upd();
  return h('li', { class: 'item' },
    h('div', { class: 'nm' },
      h('span', {}, it.n, it.src === 'szacunek' ? h('em', { class: 'est' }, 'szacunek') : null),
      meta,
      it.note ? h('small', { class: 'note' }, it.note) : null),
    h('label', { class: 'gw' }, gramInput(it.g, (g) => { it.g = g; upd(); onGrams?.(); }, 'gramy: ' + it.n), h('span', {}, 'g')),
    rk,
    onDelete ? h('button', { type: 'button', class: 'icon del', 'aria-label': 'Usuń: ' + it.n, onclick: onDelete }, '×') : null);
}

function renderItems() {
  const ul = $('#items');
  ul.replaceChildren(...day.items.map((it, i) => itemRow(it, {
    onGrams: () => { saveDay(); refresh(); },
    onDelete: () => {
      const [removed] = day.items.splice(i, 1);
      saveDay(); render();
      toast(`Usunięto: ${removed.n}`, 'Cofnij', () => { day.items.splice(i, 0, removed); saveDay(); render(); });
    },
  })));
  $('#noitems').hidden = day.items.length > 0;
}

function refresh() {
  const t = totals();
  const [lo, hi] = TARGETS.kcal;
  $('#kcal').textContent = fmt(t.k);
  const left = lo - t.k;
  $('#kcalt').textContent = t.k > hi ? `kcal · ${fmt(t.k - hi)} ponad ${hi}` : left > 0 ? `kcal · brakuje ${fmt(left)} do ${lo}` : `kcal · w normie (${lo}–${hi})`;
  $('.summary').dataset.state = t.k > hi ? 'bad' : t.k >= lo ? 'ok' : '';

  const kcalBar = bar(t.k / hi, t.k > hi ? 'bad' : t.k >= lo ? 'ok' : '', lo / hi);
  $('#bars').replaceChildren(kcalBar, ...METRICS.map((m) => {
    const v = m.val(t);
    const ref = m.kind === 'min' ? m.lo : m.hi;
    const state = m.kind === 'min' ? (v >= m.lo ? 'ok' : '') : (m.bad(t) ? 'bad' : 'ok');
    const goal = m.kind === 'min' ? `≥ ${m.lo}` : `< ${m.hi}`;
    return h('div', { class: 'metric' },
      h('div', { class: 'ml' }, h('span', {}, m.label),
        h('span', {}, h('b', {}, fmt(v, m.dec || 0)), ` / ${goal} ${m.unit}`, m.extra?.(t) ? h('small', {}, ` · ${m.extra(t)}`) : null)),
      bar(v / ref, state));
  }));
  kcalBar.classList.add('kbar');

  const mealK = new Map();
  for (const r of rowRefs) {
    const k = nutr(r.f, r.g()).k;
    r.rk.textContent = fmt(k);
    if (!skipped(r.mi)) mealK.set(r.meal, (mealK.get(r.meal) || 0) + k);
    else mealK.set(r.meal, mealK.get(r.meal) || 0);
  }
  for (const [el, k] of mealK) el.textContent = `${fmt(k)} kcal`;
  const xk = day.items.reduce((s, it) => s + nutr(it, it.g).k, 0);
  $('#xk').textContent = day.items.length ? `${fmt(xk)} kcal` : '';
}

function bar(frac, state, mark) {
  const fill = h('i');
  fill.style.width = `${Math.min(Math.max(frac, 0), 1) * 100}%`;
  const el = h('div', { class: 'bar' + (state ? ' ' + state : '') }, fill);
  if (mark) { const m = h('u'); m.style.left = `${mark * 100}%`; el.append(m); }
  return el;
}

// --- toast -------------------------------------------------------------------------
let toastTimer;
function toast(text, action, onAction) {
  const el = $('#toast');
  el.replaceChildren(h('span', {}, text));
  if (action) el.append(h('button', { type: 'button', onclick: () => { el.hidden = true; onAction(); } }, action));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3500);
}

// --- navigation ------------------------------------------------------------------
function go(deltaDays) {
  const d = new Date(cur); d.setDate(d.getDate() + deltaDays);
  cur = noon(d); loadDay(); render(); window.scrollTo(0, 0);
}
$('#prev').onclick = () => go(-1);
$('#next').onclick = () => go(1);
$('#today').onclick = () => { cur = noon(new Date()); loadDay(); render(); };
$('#seg').onclick = (e) => {
  const b = e.target.closest('[data-plan]');
  if (!b || b.dataset.plan === day.plan) return;
  day.plan = b.dataset.plan; saveDay(); render();
};
// The home-screen app can stay suspended overnight: jump to the new day when it comes back.
let lastSeen = keyOf(new Date());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = keyOf(new Date());
  if (now !== lastSeen && keyOf(cur) === lastSeen) { cur = noon(new Date()); loadDay(); render(); }
  lastSeen = now;
});

// --- composer + LLM ---------------------------------------------------------------
const q = $('#q');
const grow = () => { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 140) + 'px'; };
q.addEventListener('input', () => { grow(); store.set('draft', q.value); });
q.value = store.get('draft', ''); grow();
q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });

let abort;
$('#cancel').onclick = () => abort?.abort();

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text || abort) return;
  const apiKey = store.get('apikey', '');
  if (!apiKey) { openSettings('Wpisz klucz API, żeby liczyć wartości z opisu.'); return; }
  abort = new AbortController();
  setBusy(true);
  try {
    const items = await analyze({ apiKey, model: store.get('model', MODELS[0][0]), text, library: library(), signal: abort.signal });
    showPreview(items.map((x) => ({
      n: x.name, g: Math.round(x.grams), k: x.kcal, p: x.protein, f: x.fat, s: x.saturated_fat, b: x.fibre,
      vf: x.veg_fruit, url: x.source_url, src: x.source_name, note: x.note,
    })));
  } catch (err) {
    toast(friendlyError(err));
  } finally {
    abort = null;
    setBusy(false);
  }
});

let busyTimer;
function setBusy(on) {
  $('#status').hidden = !on;
  $('#ask').disabled = on;
  document.body.classList.toggle('busy', on);
  clearInterval(busyTimer);
  if (!on) return;
  const steps = ['Szukam wartości w sieci…', 'Sprawdzam źródła…', 'Przeliczam porcje…', 'Jeszcze chwila…'];
  let i = 0;
  $('#statustext').textContent = steps[0];
  busyTimer = setInterval(() => { i = Math.min(i + 1, steps.length - 1); $('#statustext').textContent = steps[i]; }, 12000);
}

function showPreview(items) {
  const dlg = $('#preview');
  const total = h('li', { class: 'sum' });
  const updTotal = () => { total.textContent = `Razem ${fmt(items.reduce((s, it) => s + nutr(it, it.g).k, 0))} kcal`; };
  const ul = $('#pitems');
  const draw = () => {
    ul.replaceChildren(...items.map((it, i) => itemRow(it, {
      onGrams: updTotal,
      onDelete: () => { items.splice(i, 1); draw(); },
    })), total);
    updTotal();
    $('#padd').disabled = items.length === 0;
  };
  draw();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    for (const it of items) {
      day.items.push({ ...it, id: Date.now() + Math.random() });
      if ($('#psave').checked) remember(it);
    }
    saveDay(); render();
    q.value = ''; store.del('draft'); grow();
    toast(`Dodano ${items.length} ${items.length === 1 ? 'pozycję' : 'pozycje'}.`);
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// --- manual add -------------------------------------------------------------------
const MF = { n: '#mn', g: '#mg', k: '#mk', p: '#mp', f: '#mf', s: '#ms', b: '#mb' };
$('#manualbtn').onclick = () => {
  const lib = library();
  const sel = $('#mlib');
  sel.replaceChildren(h('option', { value: '' }, '— wpisz nowy —'),
    ...Object.entries(lib).sort((a, b) => a[1].n.localeCompare(b[1].n, 'pl')).map(([k, f]) => h('option', { value: k }, f.n)));
  sel.onchange = () => {
    const f = lib[sel.value];
    if (!f) return;
    for (const c of ['n', ...NUT]) $(MF[c]).value = f[c] ?? '';
    $('#mvf').checked = !!f.vf;
    $('#mg').focus();
  };
  $('#mform').reset();
  const dlg = $('#manual');
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const f = lib[sel.value];
    const it = { n: $('#mn').value.trim(), g: num($('#mg').value), vf: $('#mvf').checked, id: Date.now() };
    for (const c of NUT) it[c] = num($(MF[c]).value);
    if (f && f.n === it.n) Object.assign(it, { url: f.url || '', src: f.src || 'moje produkty' });
    else it.src = 'etykieta';
    if (!it.n) return;
    day.items.push(it);
    if ($('#msave').checked) remember(it);
    saveDay(); render();
  };
  dlg.showModal();
};

// --- settings ---------------------------------------------------------------------
$('#smodel').replaceChildren(...MODELS.map(([id, label]) => h('option', { value: id }, label)));
$('#gear').onclick = () => openSettings();

function openSettings(note) {
  const dlg = $('#settings');
  $('#snote').hidden = !note;
  $('#snote').textContent = note || '';
  $('#skey').value = store.get('apikey', '');
  $('#smodel').value = store.get('model', MODELS[0][0]);
  renderLib();
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const key = $('#skey').value.trim();
    if (key) store.set('apikey', key); else store.del('apikey');
    store.set('model', $('#smodel').value);
    toast('Zapisano ustawienia.');
  };
  dlg.showModal();
  if (note) $('#skey').focus();
}

function renderLib() {
  const foods = customFoods();
  const keys = Object.keys(foods).sort((a, b) => a.localeCompare(b, 'pl'));
  $('#slib').replaceChildren(...(keys.length ? keys.map((k) => h('li', {},
    h('span', { class: 'nm' }, foods[k].n, h('small', { class: 'meta' }, `${fmt(foods[k].k)} kcal / 100 g`)),
    h('button', { type: 'button', class: 'icon del', 'aria-label': 'Usuń: ' + foods[k].n, onclick: () => {
      const all = customFoods(); delete all[k]; store.set('foods', all); renderLib();
    } }, '×'))) : [h('li', { class: 'empty' }, 'Jeszcze nic. Produkty dodane z opisu lub ręcznie pojawią się tutaj.')]));
}

$('#sexport').onclick = async () => {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('ft:') && k !== 'ft:apikey') data[k] = localStorage.getItem(k);
  }
  const name = `food-tracker-${keyOf(new Date())}.json`;
  const file = new File([JSON.stringify(data, null, 1)], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#simport').onclick = () => $('#sfile').click();
$('#sfile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const keys = Object.keys(data).filter((k) => k.startsWith('ft:') && k !== 'ft:apikey');
    if (!keys.length) throw new Error();
    for (const k of keys) localStorage.setItem(k, data[k]);
    loadDay(); render(); renderLib();
    toast(`Zaimportowano ${keys.length} wpisów.`);
  } catch {
    toast('To nie jest plik eksportu z tej aplikacji.');
  }
};

// --- start ------------------------------------------------------------------------
loadDay();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
