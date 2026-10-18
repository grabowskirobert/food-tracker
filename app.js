import { FOODS, PLANS, TARGETS, WEEK } from './data.js';
import { analyze, friendlyError, MODELS } from './llm.js';
import { matchText, gramsFor, aliasOf } from './match.js';

const $ = (s) => document.querySelector(s);
const NUT = ['k', 'p', 'f', 's', 'b', 'sl'];
const CATS = { fish: 'ryba', legumes: 'strączkowe', red_meat: 'czerwone mięso / wędliny' };

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
  // Days start as "Własny"; A and B stay one tap away as a template.
  day = store.get('day:' + keyOf(cur), null) || { plan: 'free', over: {}, skip: {}, items: [] };
}
function saveDay() {
  store.set('day:' + keyOf(cur), day);
}

function customFoods() { return store.get('foods', {}); }
function library() {
  const lib = {};
  for (const f of Object.values(FOODS)) lib[f.n.toLowerCase()] = f;
  return Object.assign(lib, customFoods());
}
// Saves a product (or updates one picked from the library), keeping the last portion and the
// words the user described it with, so the next description matches it locally.
function remember(f, alias) {
  const foods = customFoods();
  const key = f.key || f.n.toLowerCase();
  const old = foods[key] || FOODS[Object.keys(FOODS).find((id) => FOODS[id].n.toLowerCase() === key)] || {};
  const { n, k, p, f: fat, s, b, sl, vf, cat } = { ...old, ...f };
  const aliases = new Set(old.alias || []);
  if (alias && !n.toLowerCase().includes(alias)) aliases.add(alias);
  foods[key] = {
    n, k, p, f: fat, s, b, sl, vf, cat: cat || '',
    url: f.url ?? old.url ?? '', src: f.src ?? old.src ?? '',
    pc: f.pc || old.pc || 0, last: f.g || old.last || 0, alias: [...aliases].slice(-8),
  };
  store.set('foods', foods);
}

// --- nutrition -------------------------------------------------------------------
function nutr(f, g) {
  // nosl counts items saved before salt was tracked, so the salt total can say it is incomplete.
  const v = { vf: f.vf ? g : 0, nosl: f.sl == null && g > 0 ? 1 : 0 };
  for (const c of NUT) v[c] = (f[c] || 0) * g / 100;
  return v;
}
function addTo(t, v) { for (const c of [...NUT, 'vf', 'nosl']) t[c] += v[c]; }
const zero = () => ({ k: 0, p: 0, f: 0, s: 0, b: 0, sl: 0, vf: 0, nosl: 0 });

const plan = () => PLANS[day.plan];
const gramsOf = (mi, ii, g0) => day.over[`${day.plan}:${mi}:${ii}`] ?? g0;
const skipped = (mi) => !!day.skip[`${day.plan}:${mi}`];

// Everything eaten on a stored day: plan meals that were not skipped, plus added items.
function eatenOn(d) {
  const out = [];
  PLANS[d.plan]?.meals.forEach((m, mi) => {
    if (d.skip[`${d.plan}:${mi}`]) return;
    m.items.forEach(([id, g0], ii) => out.push([FOODS[id], d.over[`${d.plan}:${mi}:${ii}`] ?? g0]));
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
    meta.replaceChildren(`B ${fmt(v.p, 1)} · T ${fmt(v.f, 1)} · nas. ${fmt(v.s, 1)} · bł. ${fmt(v.b, 1)} · sól ${it.sl == null ? '?' : fmt(v.sl, 1)}`
      + (CATS[it.cat] ? ` · ${CATS[it.cat]}` : ''));
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
  const wk = (label, v, goal, max) => h('span', { class: max ? (v > goal ? 'bad' : '') : (v >= goal ? 'ok' : '') },
    label, ' ', h('b', {}, fmt(v)), max ? ` / ${goal} g` : `/${goal}`);
  $('#week').replaceChildren(h('small', {}, 'Ten tydzień'),
    wk('Ryba', w.fish, WEEK.fish), wk('Strączkowe', w.legumes, WEEK.legumes), wk('Czerwone mięso', w.red_meat, WEEK.red_meat, true));

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

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text || abort) return;
  const segs = matchText(text, library());
  if (segs.some((x) => x.cands.length)) showMatch(segs);
  else askClaude(text);
});

function clearDraft() { q.value = ''; store.del('draft'); grow(); }

// Known products: pick the match and amount locally; only the rest goes to Claude.
function showMatch(segs) {
  const lib = library();
  const rows = segs.map((x) => ({ ...x, pick: x.sure ? x.cands[0].key : (x.cands.length ? '' : 'web') }));
  const ul = $('#mitems');
  const draw = () => {
    ul.replaceChildren(...rows.map((r) => {
      const sel = h('select', { 'aria-label': 'Produkt dla: ' + r.seg },
        r.cands.length && !r.pick ? h('option', { value: '' }, 'Wybierz…') : null,
        r.cands.map((c) => h('option', { value: c.key }, c.f.n)),
        h('option', { value: 'web' }, 'Inne: szukaj w sieci'));
      sel.value = r.pick;
      const amt = h('span', { class: 'gw' });
      const upd = () => {
        const f = lib[r.pick];
        if (!f) { amt.replaceChildren(); r.g = 0; return; }
        if (r.g == null || r.gFor !== r.pick) { const a = gramsFor(r.amount, f); r.g = a.g; r.note = a.note; r.gFor = r.pick; }
        const kEl = h('span', { class: 'rk' }, fmt(nutr(f, r.g).k));
        amt.replaceChildren(gramInput(r.g, (g) => { r.g = g; kEl.textContent = fmt(nutr(f, g).k); }, 'gramy: ' + f.n), h('span', {}, 'g'), kEl);
      };
      sel.onchange = () => { r.pick = sel.value; upd(); drawButtons(); };
      upd();
      return h('li', { class: 'mrow' },
        h('small', { class: 'meta' }, '„' + r.seg + '”'),
        h('div', { class: 'mline' }, sel, amt),
        r.note && lib[r.pick] ? h('small', { class: 'note' }, r.note) : null);
    }));
    drawButtons();
  };
  const ok = $('#mok');
  const drawButtons = () => {
    const web = rows.filter((r) => r.pick === 'web').length;
    const open = rows.filter((r) => r.pick === '').length;
    ok.disabled = open > 0;
    ok.textContent = web ? `Dodaj i szukaj ${web === rows.length ? '' : 'reszty '}w sieci` : 'Dodaj';
  };
  draw();
  const dlg = $('#match');
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    let added = 0;
    for (const r of rows) {
      const f = lib[r.pick];
      if (!f || !r.g) continue;
      day.items.push({ n: f.n, g: r.g, k: f.k, p: f.p, f: f.f, s: f.s, b: f.b, sl: f.sl, cat: f.cat || '', vf: !!f.vf, url: f.url || '', src: f.src || 'moje produkty', note: r.note || '', id: Date.now() + Math.random() });
      remember({ ...f, key: r.pick, g: r.g }, aliasOf(r.seg));
      added++;
    }
    if (added) { saveDay(); render(); }
    const rest = rows.filter((r) => r.pick === 'web').map((r) => r.seg);
    if (rest.length) { q.value = rest.join(', '); grow(); askClaude(q.value); }
    else { clearDraft(); toast(`Dodano ${added} z moich produktów, bez zapytania do API.`); }
  };
  dlg.showModal();
}

async function askClaude(text) {
  const apiKey = store.get('apikey', '');
  if (!apiKey) { openSettings('Wpisz klucz API, żeby liczyć wartości z opisu.'); return; }
  abort = new AbortController();
  setBusy(true);
  try {
    const { items, cost } = await analyze({ apiKey, model: currentModel(), text, signal: abort.signal });
    addCost(cost);
    showPreview(items.map((x) => ({
      n: x.name, g: Math.round(x.grams), pc: Math.round(x.piece_grams) || 0, k: x.kcal, p: x.protein, f: x.fat, s: x.saturated_fat, b: x.fibre,
      sl: x.salt, cat: x.category === 'none' ? '' : x.category, vf: x.veg_fruit, url: x.source_url, src: x.source_name, note: x.note,
    })), cost);
  } catch (err) {
    toast(friendlyError(err));
  } finally {
    abort = null;
    setBusy(false);
  }
}

const monthKey = () => 'cost:' + keyOf(new Date()).slice(0, 7);
function addCost(usd) { store.set(monthKey(), store.get(monthKey(), 0) + usd); }
const usd = (x) => x.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + ' $';

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

function showPreview(items, cost) {
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
    clearDraft();
    toast(`Dodano ${items.length} ${items.length === 1 ? 'pozycję' : 'pozycje'} · zapytanie ≈ ${usd(cost)}`);
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// --- manual add -------------------------------------------------------------------
const MF = { n: '#mn', g: '#mg', k: '#mk', p: '#mp', f: '#mf', s: '#ms', b: '#mb', sl: '#msl' };
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
    $('#mcat').value = f.cat || '';
    $('#mg').focus();
  };
  $('#mform').reset();
  const dlg = $('#manual');
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const f = lib[sel.value];
    const it = { n: $('#mn').value.trim(), g: num($('#mg').value), vf: $('#mvf').checked, cat: $('#mcat').value, id: Date.now() };
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
// Stored under a new key so earlier saved choices fall back to the new default (Sonnet).
const currentModel = () => store.get('llm', MODELS[0][0]);
$('#smodel').replaceChildren(...MODELS.map(([id, label]) => h('option', { value: id }, label)));
$('#gear').onclick = () => openSettings();

function openSettings(note) {
  const dlg = $('#settings');
  $('#snote').hidden = !note;
  $('#snote').textContent = note || '';
  $('#skey').value = store.get('apikey', '');
  $('#smodel').value = currentModel();
  $('#scost').textContent = `Wydane w tym miesiącu (szacunek z tej aplikacji): ${usd(store.get(monthKey(), 0))}`;
  renderLib();
  drawFill();
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const key = $('#skey').value.trim();
    if (key) store.set('apikey', key); else store.del('apikey');
    store.set('llm', $('#smodel').value);
    toast('Zapisano ustawienia.');
  };
  dlg.showModal();
  if (note) $('#skey').focus();
}

// Products saved before salt and categories were tracked: fill them in with one Claude call,
// then patch the copies already logged on past days.
function missingSalt() { return Object.entries(customFoods()).filter(([, f]) => f.sl == null); }
function drawFill() {
  const n = missingSalt().length;
  $('#sfill').hidden = !n;
  $('#sfill').textContent = `Uzupełnij sól i kategorie z sieci (${n} ${n === 1 ? 'produkt' : 'produkty'})`;
}
$('#sfill').onclick = async () => {
  const apiKey = store.get('apikey', '');
  if (!apiKey) { toast('Najpierw wpisz klucz API.'); return; }
  const list = missingSalt();
  $('#settings').close();
  abort = new AbortController();
  setBusy(true);
  try {
    const text = 'Fill in the values for these products. Return exactly one item per line, in this order, '
      + 'keeping each name exactly as written, grams 100:\n' + list.map(([, f]) => '- ' + f.n).join('\n');
    const { items, cost } = await analyze({ apiKey, model: currentModel(), text, signal: abort.signal });
    addCost(cost);
    const foods = customFoods();
    const fixed = {};
    list.forEach(([key, f], i) => {
      const x = items.find((it) => it.name.toLowerCase() === f.n.toLowerCase()) || items[i];
      if (!x) return;
      foods[key] = { ...foods[key], sl: x.salt, cat: x.category === 'none' ? '' : x.category };
      fixed[f.n.toLowerCase()] = foods[key];
    });
    store.set('foods', foods);
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith('ft:day:')) continue;
      const d = JSON.parse(localStorage.getItem(k));
      let changed = false;
      for (const it of d.items) {
        const f = fixed[it.n.toLowerCase()];
        if (f && it.sl == null) { it.sl = f.sl; it.cat = f.cat; changed = true; }
      }
      if (changed) localStorage.setItem(k, JSON.stringify(d));
    }
    loadDay(); render();
    toast(`Uzupełnione produkty: ${Object.keys(fixed).length} · ≈ ${usd(cost)}`);
  } catch (err) {
    toast(friendlyError(err));
  } finally {
    abort = null;
    setBusy(false);
  }
};

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
