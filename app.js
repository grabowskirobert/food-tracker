import { FOODS, PLANS, TARGETS, WEEK } from './data.js';
import { analyze, friendlyError, photoForApi, MODELS } from './llm.js';
import { createSync, DEFAULT_REPO } from './sync.js';

const $ = (s) => document.querySelector(s);
const NUT = ['k', 'p', 'f', 's', 'b', 'sl'];
const CATS = { fish: 'ryba', legumes: 'strączkowe', red_meat: 'czerwone mięso / wędliny' };

// --- storage: everything lives in localStorage under "ft:" ---------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem('ft:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ft:' + k, JSON.stringify(v)); } catch { toast('Nie udało się zapisać danych.'); } },
  del(k) { try { localStorage.removeItem('ft:' + k); } catch {} },
  keys(prefix) {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('ft:' + prefix)) out.push(k.slice(3)); } } catch {}
    return out;
  },
};
navigator.storage?.persist?.();

const pad = (n) => String(n).padStart(2, '0');
// Local date, not toISOString(): that is UTC and would file late-evening meals under the wrong day.
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const noon = (d) => { const x = new Date(d); x.setHours(12, 0, 0, 0); return x; };
const fmt = (x, d = 0) => (Math.round(x * 10 ** d) / 10 ** d).toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : 0; };
const newId = () => Date.now() + Math.random();

let cur = noon(new Date());
let day;
const photos = new Map(); // lookup id → photo sent, kept for this session only (too big for storage)
const pending = []; // lookups in flight: { id, dayKey, text, grams, image, step, err, ctl, timer }

// A plan food as a logged item: plan values carry no source page.
const planItem = (id, g) => {
  const f = FOODS[id];
  return { id: newId(), n: f.n, g, k: f.k, p: f.p, f: f.f, s: f.s, b: f.b, sl: f.sl, vf: f.vf, cat: f.cat || '', src: 'jadłospis' };
};

// Every day is a plain list of items. Days saved while the A/B plans were a day mode are converted
// once, when first shown: the meals that were not skipped become items with the grams that were set.
function loadDay() {
  day = store.get('day:' + keyOf(cur), null) || { plan: 'free', over: {}, skip: {}, items: [] };
  const p = PLANS[day.plan];
  if (!p) return;
  const fromPlan = [];
  p.meals.forEach((m, mi) => {
    if (day.skip?.[`${day.plan}:${mi}`]) return;
    m.items.forEach(([id, g0], ii) => {
      const g = day.over?.[`${day.plan}:${mi}:${ii}`] ?? g0;
      if (g > 0) fromPlan.push(planItem(id, g));
    });
  });
  day.items = [...fromPlan, ...day.items];
  Object.assign(day, { plan: 'free', over: {}, skip: {} });
  saveDay();
}
// Every record carries `upd` (ms); sync keeps the newest copy of each day.
function saveDay() {
  day.upd = Date.now();
  store.set('day:' + keyOf(cur), day);
  sync.dirtyDay(keyOf(cur));
}

// --- nutrition -------------------------------------------------------------------
// `vf` is the share of vegetables and fruit in a product, in grams per 100 g: 100 for an apple, 0 for
// bread, in between for a dish. Older records hold true/false.
const vfShare = (v) => (v === true ? 100 : Number(v) || 0);
function nutr(f, g) {
  // nosl counts items saved before salt was tracked, so the salt total can say it is incomplete.
  const v = { vf: vfShare(f.vf) * g / 100, nosl: f.sl == null && g > 0 ? 1 : 0 };
  for (const c of NUT) v[c] = (f[c] || 0) * g / 100;
  return v;
}
function addTo(t, v) { for (const c of [...NUT, 'vf', 'nosl']) t[c] += v[c]; }
const zero = () => ({ k: 0, p: 0, f: 0, s: 0, b: 0, sl: 0, vf: 0, nosl: 0 });

// Everything eaten on a stored day. Days not yet shown since the plans stopped being a day mode
// may still hold a plan; their plan meals count until the day is converted.
function eatenOn(d) {
  const out = [];
  PLANS[d.plan]?.meals.forEach((m, mi) => {
    if (d.skip?.[`${d.plan}:${mi}`]) return;
    m.items.forEach(([id, g0], ii) => out.push([FOODS[id], d.over?.[`${d.plan}:${mi}:${ii}`] ?? g0]));
  });
  for (const it of d.items) out.push([it, it.g]);
  return out;
}

// Monday–Sunday week of the shown day: days with fish, days with legumes, grams of red meat.
function weekTotals() {
  const w = { fish: 0, legumes: 0, red_meat: 0 };
  const mon = new Date(cur); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon); d.setDate(d.getDate() + i);
    const dd = keyOf(d) === keyOf(cur) ? day : store.get('day:' + keyOf(d), null);
    if (!dd) continue;
    const eaten = eatenOn(dd).filter(([, g]) => g > 0);
    if (eaten.some(([f]) => f.cat === 'fish')) w.fish++;
    if (eaten.some(([f]) => f.cat === 'legumes')) w.legumes++;
    w.red_meat += eaten.filter(([f]) => f.cat === 'red_meat').reduce((sum, [, g]) => sum + g, 0);
  }
  return w;
}

function totals() {
  const t = zero();
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
  { label: 'Sól', unit: 'g', val: (t) => t.sl, kind: 'max', hi: TARGETS.salt[0], dec: 1, bad: (t) => t.sl >= TARGETS.salt[0],
    extra: (t) => (t.nosl ? `bez danych: ${t.nosl} poz.` : null) },
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
    type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: value ? String(value) : '', placeholder: 'g', class: 'g',
    'aria-label': label, onfocus: (e) => e.target.select(),
    oninput: (e) => onChange(num(e.target.value)),
  });
}

// --- rendering -------------------------------------------------------------------
function render() {
  renderDate();
  renderItems();
  drawBody();
  refresh();
}

function renderDate() {
  const today = noon(new Date());
  const diff = Math.round((today - cur) / 864e5);
  $('#dlabel').textContent = diff === 0 ? 'Dziś' : diff === 1 ? 'Wczoraj' : cur.toLocaleDateString('pl-PL', { weekday: 'long' });
  $('#dsub').textContent = cur.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' });
  $('#next').disabled = diff <= 0;
}

// Inspiration: the A/B menus as a reference; "Dodaj" logs a whole meal as separate items.
let inspoPlan = store.get('inspo', 'A');
function renderInspo() {
  for (const b of $('#seg').children) b.setAttribute('aria-checked', String(b.dataset.plan === inspoPlan));
  $('#meals').replaceChildren(...PLANS[inspoPlan].meals.map((m) => {
    const k = m.items.reduce((s, [id, g]) => s + nutr(FOODS[id], g).k, 0);
    return h('article', { class: 'meal' },
      h('header', {},
        h('h3', {}, m.name), h('span', { class: 'mk' }, `${fmt(k)} kcal`),
        h('button', { type: 'button', class: 'chip add', onclick: () => addMeal(m) }, '+ Dodaj')),
      h('p', { class: 'mlist' }, m.items.map(([id, g]) => `${FOODS[id].n} ${g} g`).join(' · ')));
  }));
}
function addMeal(m) {
  const added = m.items.map(([id, g]) => planItem(id, g));
  const dayKey = keyOf(cur);
  day.items.push(...added);
  saveDay(); render();
  toast(`Dodano: ${m.name.toLowerCase()}`, 'Cofnij', () => removeItemsFromDay(dayKey, added.map((it) => it.id)));
}
$('#seg').onclick = (e) => {
  const b = e.target.closest('[data-plan]');
  if (!b) return;
  inspoPlan = b.dataset.plan; store.set('inspo', inspoPlan); renderInspo();
};

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'źródło'; } };

function itemRow(it, { onGrams, onDelete, onEdit }) {
  const rk = h('span', { class: 'rk' });
  const meta = h('small', { class: 'meta' });
  const upd = () => {
    const v = nutr(it, it.g);
    rk.textContent = `${fmt(v.k)} kcal`;
    meta.replaceChildren(`B ${fmt(v.p, 1)} · T ${fmt(v.f, 1)} · nas. ${fmt(v.s, 1)} · bł. ${fmt(v.b, 1)} · sól ${it.sl == null ? '?' : fmt(v.sl, 1)}`
      + (CATS[it.cat] ? ` · ${CATS[it.cat]}` : ''));
    // The link shows the site, not the model's long source description (that stays in the tooltip).
    if (/^https?:\/\//.test(it.url || '')) meta.append(' · ', h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer', title: it.src || '' }, hostOf(it.url)));
    else if (it.src && it.src !== 'szacunek') meta.append(' · ', it.src.slice(0, 40));
  };
  upd();
  // Long notes (a dish's recipe) stay at two lines until tapped.
  const note = it.note ? h('small', { class: 'note', title: 'Dotknij, żeby rozwinąć', onclick: (e) => e.currentTarget.classList.toggle('open') }, it.note) : null;
  return h('li', { class: 'item' },
    h('div', { class: 'ihead' },
      h('span', { class: 'iname' }, it.n, it.src === 'szacunek' ? h('em', { class: 'est' }, 'szacunek') : null),
      onEdit ? h('button', { type: 'button', class: 'icon edit', 'aria-label': 'Edytuj: ' + it.n, onclick: onEdit }, '✎') : null,
      onDelete ? h('button', { type: 'button', class: 'icon del', 'aria-label': 'Usuń: ' + it.n, onclick: onDelete }, '×') : null),
    meta, note,
    h('div', { class: 'ifoot' },
      h('label', { class: 'gw' }, gramInput(it.g, (g) => { it.g = g; upd(); onGrams?.(); }, 'gramy: ' + it.n), h('span', {}, 'g')),
      rk));
}

function renderItems() {
  const ul = $('#items');
  const here = pending.filter((p) => p.dayKey === keyOf(cur));
  ul.replaceChildren(...day.items.map((it, i) => itemRow(it, {
    onGrams: () => { saveDay(); refresh(); },
    onEdit: () => openItemDialog(it),
    onDelete: () => {
      const [removed] = day.items.splice(i, 1);
      saveDay(); render();
      toast(`Usunięto: ${removed.n}`, 'Cofnij', () => { day.items.splice(i, 0, removed); saveDay(); render(); });
    },
  })), ...here.map(pendingRow));
  $('#noitems').hidden = day.items.length > 0 || here.length > 0;
}

function refresh() {
  const t = totals();
  const [lo, hi] = TARGETS.kcal;
  $('#kcal').textContent = fmt(t.k);
  const left = lo - t.k;
  $('#kcalt').textContent = !t.k ? `kcal · cel ${lo}–${hi}` : t.k > hi ? `kcal · ${fmt(t.k - hi)} ponad ${hi}` : left > 0 ? `kcal · brakuje ${fmt(left)} do ${lo}` : `kcal · w normie (${lo}–${hi})`;
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

  const w = weekTotals();
  const wk = (label, v, goal, max) => h('span', { class: max ? (v > goal ? 'bad' : 'ok') : (v >= goal ? 'ok' : '') },
    label, ' ', h('b', {}, fmt(v)), max ? ` / max ${goal} g` : `/${goal}`);
  $('#week').replaceChildren(h('small', {}, 'Ten tydzień'),
    wk('Ryba', w.fish, WEEK.fish), wk('Strączkowe', w.legumes, WEEK.legumes), wk('Czerwone mięso', w.red_meat, WEEK.red_meat, true));

  $('#xk').textContent = day.items.length ? `${fmt(t.k)} kcal` : '';
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
// The home-screen app can stay suspended overnight: jump to the new day when it comes back.
let lastSeen = keyOf(new Date());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = keyOf(new Date());
  if (now !== lastSeen && keyOf(cur) === lastSeen) { cur = noon(new Date()); loadDay(); render(); }
  lastSeen = now;
});

// --- AI: description or photo ----------------------------------------------------
// One sheet for both modes: with a photo the description is optional. The weight of the portion is
// optional in both; without it Claude estimates from the description or the photo.
const q = $('#q');
q.addEventListener('input', () => { if (!shot) store.set('draft', q.value); });
let shot = null; // { file, url } of the photo in the sheet

function openAi(photo) {
  if (!store.get('apikey', '')) { openSettings('Wpisz klucz API, żeby liczyć wartości przez AI.'); return; }
  const dlg = $('#ai');
  if (shot) URL.revokeObjectURL(shot.url);
  shot = photo ? { file: photo, url: URL.createObjectURL(photo) } : null;
  $('#aititle').textContent = photo ? 'Co jest na zdjęciu?' : 'Co zjadłeś?';
  $('#ailabel').textContent = photo ? 'Opis (opcjonalnie)' : 'Opis';
  q.placeholder = photo ? 'np. kurczak z ryżem, sos śmietanowy' : 'np. 2 jajka sadzone, kromka chleba razowego';
  q.required = !photo;
  q.value = photo ? '' : store.get('draft', '');
  $('#aiimg').hidden = !photo;
  if (photo) $('#aiimg').src = shot.url;
  $('#qg').value = '';
  $('#aihint').textContent = photo
    ? 'Podaj wagę, jeśli ważyłeś porcję. Bez niej porcja jest szacowana ze zdjęcia.'
    : 'Kilka rzeczy oddziel przecinkami. Danie z listą składników („owsianka z bananem, skyrem”) liczy się jako jedna pozycja.';
  dlg.returnValue = '';
  dlg.onclose = () => {
    const ok = dlg.returnValue === 'ok';
    const text = q.value.trim(), grams = num($('#qg').value), file = shot?.file;
    if (ok && (text || file)) {
      if (!file) store.del('draft');
      startLookup({ text, grams, file });
    }
    if (shot) { URL.revokeObjectURL(shot.url); shot = null; }
  };
  dlg.showModal();
  if (!photo) q.focus();
}
$('#aibtn').onclick = () => openAi(null);
$('#photobtn').onclick = () => $('#photofile').click();
$('#photofile').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) openAi(file);
};
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && q.value.trim()) { e.preventDefault(); $('#ai').close('ok'); }
});

// A lookup appears at once as a row with a spinner and the result replaces it in place. Several can
// run side by side, and a result always lands on the day it was started for.
const STEPS = ['Liczę wartości…', 'Sprawdzam źródło…', 'Przeliczam porcje…', 'Jeszcze chwila…'];
const plPos = (n) => (n === 1 ? '1 pozycję' : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? `${n} pozycje` : `${n} pozycji`);
const lookupLabel = (p) => [p.file ? 'Zdjęcie' : '', p.text, p.grams ? `${fmt(p.grams)} g` : ''].filter(Boolean).join(' · ');

function pendingRow(p) {
  const st = h('span', {}, p.err || STEPS[p.step]);
  p.stEl = st;
  return h('li', { class: 'item pend' + (p.err ? ' err' : ''), 'aria-busy': String(!p.err) },
    h('div', { class: 'ihead' },
      h('span', { class: 'iname' }, lookupLabel(p)),
      p.err ? h('button', { type: 'button', class: 'chip', onclick: () => { runLookup(p); renderItems(); } }, 'Ponów') : null,
      h('button', {
        type: 'button', class: 'icon del', 'aria-label': p.err ? 'Usuń' : 'Przerwij',
        onclick: () => { if (p.err) { pending.splice(pending.indexOf(p), 1); renderItems(); } else p.ctl.abort(); },
      }, '×')),
    h('small', { class: 'meta' }, p.err ? null : h('i', { class: 'spin' }), st));
}

function startLookup({ text, grams, file }) {
  const p = { id: newId(), dayKey: keyOf(cur), text, grams, file, step: 0, err: '' };
  pending.push(p);
  runLookup(p);
  renderItems();
  $('#items').lastElementChild?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function runLookup(p) {
  p.err = ''; p.step = 0;
  p.ctl = new AbortController();
  clearInterval(p.timer);
  p.timer = setInterval(() => {
    p.step = Math.min(p.step + 1, STEPS.length - 1);
    if (p.stEl && !p.err) p.stEl.textContent = STEPS[p.step];
  }, 8000);
  const model = currentModel();
  try {
    p.image ??= p.file ? await photoForApi(p.file) : null;
    const res = await analyze({ apiKey: store.get('apikey', ''), model, text: p.text, grams: p.grams, image: p.image, signal: p.ctl.signal });
    logCost(model, lookupLabel(p), res);
    if (p.image) photos.set(p.id, p.image);
    finishLookup(p, res.items, model);
  } catch (err) {
    clearInterval(p.timer);
    if (err.usage) logCost(model, lookupLabel(p), err);
    if (p.ctl.signal.aborted) {
      pending.splice(pending.indexOf(p), 1);
      if (!p.file && !store.get('draft', '')) store.set('draft', p.text); // the text waits in the sheet for editing
    } else {
      p.err = friendlyError(err);
    }
    renderItems();
  }
}

function finishLookup(p, items, model) {
  clearInterval(p.timer);
  pending.splice(pending.indexOf(p), 1);
  const added = toItems(items, { lid: p.id, q: { text: p.text, grams: p.grams, photo: !!p.file }, m: model });
  addItemsToDay(p.dayKey, added);
  if (p.dayKey === keyOf(cur)) $('#items').lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  toast(`Dodano ${plPos(added.length)}`, 'Cofnij', () => removeItemsFromDay(p.dayKey, added.map((it) => it.id)));
}
// lid ties the items of one lookup together; q is what was asked, m the model that answered.
const toItems = (items, extra) => items.map((x) => ({
    id: newId(), n: x.name, g: Math.round(x.grams),
    k: x.kcal, p: x.protein, f: x.fat, s: x.saturated_fat, b: x.fibre, sl: x.salt,
    cat: x.category === 'none' ? '' : x.category, vf: x.veg_fruit_g, url: x.source_url, src: x.source_name, note: x.note, ...extra,
}));

function addItemsToDay(dayKey, items) {
  if (dayKey === keyOf(cur)) { day.items.push(...items); saveDay(); render(); return; }
  const d = store.get('day:' + dayKey, null) || { plan: 'free', over: {}, skip: {}, items: [] };
  d.items.push(...items); d.upd = Date.now();
  store.set('day:' + dayKey, d); sync.dirtyDay(dayKey);
}
function removeItemsFromDay(dayKey, ids) {
  if (dayKey === keyOf(cur)) { day.items = day.items.filter((it) => !ids.includes(it.id)); saveDay(); render(); return; }
  const d = store.get('day:' + dayKey, null);
  if (!d) return;
  d.items = d.items.filter((it) => !ids.includes(it.id)); d.upd = Date.now();
  store.set('day:' + dayKey, d); sync.dirtyDay(dayKey);
}

// --- cost log -----------------------------------------------------------------------
// The month total plus the last 50 requests with their token counts, so it shows what costs most.
const monthKey = () => 'cost:' + keyOf(new Date()).slice(0, 7);
const usd = (x) => x.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + ' $';
function logCost(model, what, { cost, usage }) {
  store.set(monthKey(), store.get(monthKey(), 0) + cost);
  store.set('costlog', [{ t: Date.now(), model, what: what.slice(0, 80), cost, ...usage }, ...store.get('costlog', [])].slice(0, 50));
}
const shortModel = (id) => (MODELS.find(([m]) => m === id)?.[1] || id).replace(/^Claude /, '').replace(/ \(.*\)$/, '');
const kTok = (n) => (n >= 1000 ? `${fmt(n / 1000, n < 10000 ? 1 : 0)}k` : String(n));
function renderCostLog() {
  const log = store.get('costlog', []);
  $('#scost').textContent = `Wydane w tym miesiącu: ${usd(store.get(monthKey(), 0))}`;
  $('#slog').replaceChildren(...(log.length ? log.map((x) => h('li', {},
    h('span', { class: 'nm' }, x.what,
      h('small', { class: 'meta' }, `${when(x.t)} · ${shortModel(x.model)} · wej. ${kTok(x.in)} · wyj. ${kTok(x.out)} · wysz. ${x.searches}`)),
    h('span', { class: 'rk' }, usd(x.cost)))) : [h('li', { class: 'empty' }, 'Brak zapytań.')]));
}

// --- add by hand / edit an item ----------------------------------------------------
const MF = { n: '#mn', g: '#mg', k: '#mk', p: '#mp', f: '#mf', s: '#ms', b: '#mb', sl: '#msl' };
$('#manualbtn').onclick = () => openItemDialog(null);

// Category chips (no native picker: a <select> inside a sheet opened misplaced on iOS).
const catBox = $('#mcat');
const setCat = (v) => { for (const b of catBox.children) b.setAttribute('aria-checked', String(b.dataset.v === (v || ''))); };
const getCat = () => [...catBox.children].find((b) => b.getAttribute('aria-checked') === 'true')?.dataset.v || '';
catBox.onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) setCat(b.dataset.v); };

// Things eaten in the last two weeks, newest first, one per name: a tap fills the form to log it again.
function recentItems(limit = 8) {
  const seen = new Map();
  for (let o = 0; o < 14 && seen.size < limit; o++) {
    const d = new Date(); d.setDate(d.getDate() - o);
    const dd = keyOf(d) === keyOf(cur) ? day : store.get('day:' + keyOf(d), null);
    for (const it of [...(dd?.items || [])].reverse()) {
      const k = it.n.toLowerCase();
      if (!seen.has(k) && seen.size < limit) seen.set(k, it);
    }
  }
  return [...seen.values()];
}

// One sheet for both: adding by hand (editing = null) and correcting an item already logged.
// Values are per 100 g; the amount eaten is separate.
function openItemDialog(editing) {
  const dlg = $('#manual');
  let from = null; // a recent item the form was filled from: keeps its source and note
  $('#mtitle').textContent = editing ? 'Edytuj pozycję' : 'Dodaj ręcznie';
  $('#mnoterow').hidden = !editing;
  $('#msubmit').textContent = editing ? 'Zapisz' : 'Dodaj';
  $('#mform').reset();
  setCat('');

  const fill = (f) => {
    for (const c of ['n', ...NUT]) $(MF[c]).value = f[c] ?? '';
    $('#mg').value = f.g || '';
    $('#mvf').value = vfShare(f.vf) || '';
    setCat(f.cat || '');
  };
  const recent = editing ? [] : recentItems();
  $('#mrecent').hidden = !recent.length;
  $('#mrecentlist').replaceChildren(...recent.map((it) => h('button', {
    type: 'button', onclick: () => { from = it; fill(it); $('#mg').focus(); },
  }, it.n.length > 28 ? it.n.slice(0, 27) + '…' : it.n)));

  if (editing) { fill(editing); $('#mnote').value = editing.note || ''; }
  const canCompare = !!editing?.q && (!editing.q.photo || photos.has(editing.lid));
  $('#mcompare').hidden = !canCompare;
  $('#mcompare').onclick = () => { dlg.close('cancel'); openCompare(editing); };

  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const n = $('#mn').value.trim();
    if (!n) return;
    const vals = { n, g: num($('#mg').value), vf: Math.min(100, num($('#mvf').value)), cat: getCat() };
    // An empty salt field means "unknown" (flagged in the day's salt bar), not zero.
    for (const c of NUT) vals[c] = c === 'sl' && $(MF.sl).value === '' ? undefined : num($(MF[c]).value);
    if (editing) {
      Object.assign(editing, vals, { note: $('#mnote').value.trim() });
    } else {
      const same = from && from.n === n;
      day.items.push({ ...vals, id: newId(), src: same ? from.src || '' : 'etykieta', url: same ? from.url || '' : '', note: same ? from.note || '' : '' });
    }
    saveDay(); render();
  };
  dlg.showModal();
  if (!editing && !recent.length) $('#mn').focus();
}

// --- compare an AI result with another model -----------------------------------------
// Sends the same description (or this session's photo) to another model and shows both answers side by side;
// "Użyj nowych wartości" swaps the items of that lookup for the new ones.
function openCompare(it) {
  const dlg = $('#compare');
  const dayKey = keyOf(cur);
  const group = () => day.items.filter((x) => x.lid === it.lid);
  const others = MODELS.filter(([id]) => id !== it.m);
  let pick = others.find(([id]) => id === 'claude-sonnet-5-5')?.[0] || others[0][0];
  let fresh = null, ctl = null;
  $('#cqtext').textContent = `„${[it.q.photo ? 'Zdjęcie' : '', it.q.text, it.q.grams ? `${fmt(it.q.grams)} g` : ''].filter(Boolean).join(' · ')}” · teraz: ${shortModel(it.m || '')}`;
  const chips = () => $('#cmodels').replaceChildren(...others.map(([id]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(id === pick), onclick: () => { pick = id; chips(); },
  }, shortModel(id))));
  chips();
  const table = (title, items, cost) => h('section', {},
    h('h3', {}, title, cost != null ? h('small', {}, ` · ${usd(cost)}`) : null),
    h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['', 'g', 'kcal', 'B', 'T', 'nas.', 'bł.', 'sól'].map((x) => h('th', {}, x)))),
      h('tbody', {}, items.map((x) => h('tr', {}, h('td', { class: 'n' }, x.n), h('td', {}, fmt(x.g)),
        ...['k', 'p', 'f', 's', 'b', 'sl'].map((c) => h('td', {}, x[c] == null ? '?' : fmt(x[c] * x.g / 100, c === 'k' ? 0 : 1)))))))));
  $('#cout').replaceChildren(table(shortModel(it.m || '') || 'Teraz', group()));
  $('#cstat').textContent = 'Wartości dla zjedzonej porcji.';
  $('#crun').hidden = false; $('#crun').disabled = false; $('#cuse').hidden = true;
  $('#crun').onclick = async () => {
    $('#crun').disabled = true;
    $('#cstat').replaceChildren(h('i', { class: 'spin' }), ` Pytam ${shortModel(pick)}…`);
    ctl = new AbortController();
    const model = pick;
    try {
      const res = await analyze({ apiKey: store.get('apikey', ''), model, text: it.q.text, grams: it.q.grams, image: it.q.photo ? photos.get(it.lid) : null, signal: ctl.signal });
      logCost(model, `Porównanie: ${it.q.text || 'zdjęcie'}`, res);
      fresh = toItems(res.items, { lid: it.lid, q: it.q, m: model });
      $('#cout').append(table(shortModel(model), fresh, res.cost));
      $('#cstat').textContent = 'Wartości dla zjedzonej porcji.';
      $('#crun').hidden = true; $('#cuse').hidden = false;
    } catch (err) {
      if (err.usage) logCost(model, `Porównanie: ${it.q.text || 'zdjęcie'}`, err);
      $('#cstat').textContent = ctl.signal.aborted ? '' : friendlyError(err);
      $('#crun').disabled = false;
    }
  };
  $('#cuse').onclick = () => {
    if (keyOf(cur) !== dayKey || !fresh) { dlg.close(); return; }
    const old = group();
    const at = day.items.indexOf(old[0]);
    day.items = day.items.filter((x) => x.lid !== it.lid);
    day.items.splice(at < 0 ? day.items.length : at, 0, ...fresh);
    saveDay(); render();
    dlg.close();
    toast(`Zastąpiono wartościami z ${shortModel(fresh[0]?.m || '')}`, 'Cofnij', () => {
      day.items = day.items.filter((x) => x.lid !== it.lid);
      day.items.splice(at < 0 ? day.items.length : at, 0, ...old);
      saveDay(); render();
    });
  };
  dlg.onclose = () => ctl?.abort();
  dlg.showModal();
}

// --- settings ---------------------------------------------------------------------
const currentModel = () => store.get('llm', MODELS[0][0]);
$('#smodel').replaceChildren(...MODELS.map(([id, name]) => h('option', { value: id }, name)));
$('#gear').onclick = () => openSettings();

// Saved values show masked with "Zmień"; nothing opens the keyboard until the user asks to edit.
// Every change saves at once, so the sheet closes with ×, a tap outside or Escape.
const mask = (v) => (v.length > 12 ? `${v.slice(0, 7)}…${v.slice(-4)}` : '••••');
function editRow(view, form, open) { $(view).hidden = open; $(form).hidden = !open; }
function drawKey(edit = false) {
  const key = store.get('apikey', '');
  $('#keyshow').textContent = key ? mask(key) : 'brak';
  editRow('#keyview', '#keyform', edit || !key);
  $('#keycancel').hidden = !key;
  $('#skey').value = '';
}
function drawGh(edit = false) {
  const token = store.get('ghtoken', ''), repo = store.get('ghrepo', '') || DEFAULT_REPO;
  $('#ghshow').textContent = token ? `${repo} · token ${mask(token)}` : 'wyłączona';
  editRow('#ghview', '#ghform', edit);
  $('#ghtoken').value = '';
  $('#ghtoken').placeholder = token ? `Token: ${mask(token)} (puste = bez zmian)` : 'Token: github_pat_…';
  $('#ghrepo').value = store.get('ghrepo', '');
  $('#ghrepo').placeholder = DEFAULT_REPO;
}
$('#keyedit').onclick = () => { drawKey(true); $('#skey').focus(); };
$('#keycancel').onclick = () => drawKey();
$('#keysave').onclick = () => {
  const key = $('#skey').value.trim();
  if (!key) { $('#skey').focus(); return; }
  store.set('apikey', key); drawKey(); $('#snote').hidden = true; toast('Zapisano klucz.');
};
$('#skey').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#keysave').click(); } });
$('#ghedit').onclick = () => { drawGh(true); $('#ghtoken').focus(); };
$('#ghcancel').onclick = () => drawGh();
$('#ghsave').onclick = () => {
  if (applySync()) sync.start({ full: true });
  drawGh(); drawSync(); toast('Zapisano.');
};
$('#smodel').onchange = () => { store.set('llm', $('#smodel').value); toast(`Model: ${shortModel($('#smodel').value)}`); };

function openSettings(note) {
  const dlg = $('#settings');
  $('#snote').hidden = !note;
  $('#snote').textContent = note || '';
  $('#smodel').value = currentModel();
  drawKey(); drawGh(); drawSync(); renderCostLog();
  dlg.showModal();
  if (note) $('#skey').focus();
}

$('#sexport').onclick = async () => {
  const data = {};
  for (const k of store.keys('day:')) {
    const raw = localStorage.getItem('ft:' + k);
    if (raw != null) data['ft:' + k] = raw;
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
    const keys = Object.keys(data).filter((k) => k.startsWith('ft:day:'));
    if (!keys.length) throw new Error();
    // Newest `upd` wins, so an older export never overwrites newer entries.
    let taken = 0;
    for (const k of keys) {
      const rec = JSON.parse(data[k]);
      const local = store.get(k.slice(3), null);
      if (local == null || (rec.upd || 0) > (local.upd || 0)) { store.set(k.slice(3), rec); sync.dirtyDay(k.slice(7)); taken++; }
    }
    loadDay(); render();
    toast(taken ? `Zaimportowano dni: ${taken}.` : 'Nic do zaimportowania: masz już nowsze dane.');
  } catch {
    toast('To nie jest plik eksportu z tej aplikacji.');
  }
};

// --- weight and waist ---------------------------------------------------------------
const dayAt = (d) => (keyOf(d) === keyOf(cur) ? day : store.get('day:' + keyOf(d), null));
const back = (n) => { const x = new Date(cur); x.setDate(x.getDate() - n); return x; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
// Values of a field on the days `from`..`to` before the shown one (0 = the shown day).
function span(field, from, to) {
  const out = [];
  for (let o = from; o <= to; o++) { const v = dayAt(back(o))?.[field]; if (v > 0) out.push(v); }
  return out;
}
function lastOf(field, from) {
  for (let o = from; o < from + 60; o++) { const v = dayAt(back(o))?.[field]; if (v > 0) return { v, o }; }
  return null;
}
const signed = (x, d, unit) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${fmt(Math.abs(x), d)} ${unit}`;

function drawBody() {
  $('#bw').value = day.w ?? '';
  $('#bt').value = day.t ?? '';
  drawTrend();
}
function drawTrend() {
  const lines = [];
  const now = span('w', 0, 6), before = span('w', 7, 13);
  if (now.length) {
    let t = `Waga: średnia 7 dni ${fmt(mean(now), 1)} kg (${now.length} pom.)`;
    if (before.length) t += ` · ${signed(mean(now) - mean(before), 1, 'kg')} vs poprzedni tydzień`;
    lines.push(t);
  }
  const last = lastOf('t', 0);
  if (last) {
    let t = `Talia: ${fmt(last.v, 1)} cm${last.o ? ` (${last.o} dni temu)` : ''}`;
    const older = lastOf('t', last.o + 7);
    if (older) t += ` · ${signed(last.v - older.v, 1, 'cm')} vs ${older.o - last.o} dni wcześniej`;
    lines.push(t);
  }
  $('#btrend').replaceChildren(...(lines.length ? lines : ['Zmierz się rano, przed jedzeniem; trend liczę ze średniej tygodnia.']).map((l) => h('div', {}, l)));
}
for (const [id, field] of [['#bw', 'w'], ['#bt', 't']]) {
  $(id).addEventListener('input', (e) => {
    const v = num(e.target.value);
    if (v) day[field] = v; else delete day[field];
    saveDay(); drawTrend();
  });
}

// --- sync with the private data repo ------------------------------------------------
const monthOf = (d) => keyOf(d).slice(0, 7);
const sync = createSync({
  store,
  focusMonths: () => {
    const now = new Date();
    return [...new Set([monthOf(now), monthOf(new Date(now.getFullYear(), now.getMonth() - 1, 1)), monthOf(cur)])];
  },
  onStatus: () => drawSync(),
  onRemote: ({ days }) => {
    if (!days.includes(keyOf(cur))) return;
    loadDay();
    if (typing()) pendingRender = true; else render();
  },
});

// A remote update must not redraw under the user's fingers: wait until the field loses focus.
let pendingRender = false;
const typing = () => !!document.activeElement?.matches?.('input, textarea, select');
document.addEventListener('focusout', () => {
  if (!pendingRender) return;
  pendingRender = false;
  setTimeout(() => { if (!typing()) render(); }, 0);
});

const when = (ts) => new Date(ts).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
let warnedStale = false;
function syncLine(st) {
  const last = st.last ? ` Ostatnia udana: ${when(st.last)}.` : '';
  if (st.state === 'off') return 'Synchronizacja wyłączona. Wklej token, żeby zapisywać kopię w repo.';
  if (st.state === 'busy') return 'Synchronizuję…';
  if (st.state === 'ok') return `Zsynchronizowano ${when(st.last)}.`;
  if (st.state === 'pending') return `${st.dirty ? `Do wysłania: ${st.dirty}. ` : ''}${st.err ? `Błąd: ${st.err}` : ''}${last}`.trim() || 'Czeka na pierwszą synchronizację.';
  return `Błąd: ${st.err || 'brak synchronizacji'}${last}`;
}
function drawSync() {
  const st = sync.status();
  const dot = $('#syncdot');
  dot.dataset.state = st.state;
  dot.title = syncLine(st);
  $('#syncstat').textContent = syncLine(st);
  if (st.state === 'bad' && st.last && !warnedStale) {
    warnedStale = true;
    toast(`Kopia nieaktualna od ${Math.max(st.staleDays, 1)} dni: ${st.err || 'brak synchronizacji'}`);
  }
  if (st.state === 'ok') warnedStale = false;
}

// Saves the token and repo fields; a change starts the first sync from scratch.
function applySync() {
  const token = $('#ghtoken').value.trim() || store.get('ghtoken', '');
  const repo = $('#ghrepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
  const changed = token !== store.get('ghtoken', '') || repo !== store.get('ghrepo', '');
  if (token) store.set('ghtoken', token); else store.del('ghtoken');
  if (repo) store.set('ghrepo', repo); else store.del('ghrepo');
  if (changed) sync.resetSynced();
  return changed;
}
$('#syncnow').onclick = async () => {
  await sync.start({ full: true });
  drawSync();
};

sync.start({ full: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync.start({ full: true }); else sync.flush();
});
addEventListener('pagehide', () => sync.flush());
addEventListener('online', () => sync.start({ full: true }));
drawSync();

// A tap on the backdrop closes a sheet, except the manual form, where it would lose typed values.
for (const id of ['#settings', '#compare', '#ai']) {
  $(id).addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close('cancel'); });
}

// --- start ------------------------------------------------------------------------
loadDay();
render();
renderInspo();
// The first screen is up: boot.js stands down and its reload guard resets.
window.__ftReady = true;
try { sessionStorage.removeItem('ft:heal'); } catch {}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
