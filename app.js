import { FOODS, PLANS, TARGETS, WEEK } from './data.js';
import { analyze, friendlyError, MODELS } from './llm.js';
import { matchText, gramsFor, aliasOf, suggest } from './match.js';
import { createSync, mergeMaps, DEFAULT_REPO } from './sync.js';

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

let cur = noon(new Date());
let day;
const pending = []; // lookups in flight: { id, dayKey, text, step, err, ctl, timer }

function loadDay() {
  // Days start as "Własny"; A and B stay one tap away as a template.
  day = store.get('day:' + keyOf(cur), null) || { plan: 'free', over: {}, skip: {}, items: [] };
}
// Every record carries `upd` (ms); sync keeps the newest copy of each day and product.
function saveDay() {
  day.upd = Date.now();
  store.set('day:' + keyOf(cur), day);
  sync.dirtyDay(keyOf(cur));
}

// Deleted products stay as { del, upd } so the deletion reaches the other device.
const allFoods = () => store.get('foods', {});
function customFoods() {
  return Object.fromEntries(Object.entries(allFoods()).filter(([, f]) => !f.del));
}
function saveFoods(foods) { store.set('foods', foods); sync.dirtyFoods(); }
function library() {
  const lib = {};
  for (const f of Object.values(FOODS)) lib[f.n.toLowerCase()] = f;
  return Object.assign(lib, customFoods());
}
// Saves a product (or updates one picked from the library), keeping the last portion and the
// words the user described it with, so the next description matches it locally.
function remember(f, alias) {
  const foods = allFoods();
  const key = f.key || f.n.toLowerCase();
  const old = (foods[key] && !foods[key].del ? foods[key] : null) || FOODS[Object.keys(FOODS).find((id) => FOODS[id].n.toLowerCase() === key)] || {};
  const { n, k, p, f: fat, s, b, sl, vf, cat } = { ...old, ...f };
  const aliases = new Set(old.alias || []);
  if (alias && !n.toLowerCase().includes(alias)) aliases.add(alias);
  foods[key] = {
    n, k, p, f: fat, s, b, sl, vf, cat: cat || '',
    url: f.url ?? old.url ?? '', src: f.src ?? old.src ?? '',
    pc: f.pc || old.pc || 0, last: f.g || old.last || 0, alias: [...aliases].slice(-8), upd: Date.now(),
  };
  saveFoods(foods);
  return { key, created: !old.n };
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
    type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: value ? String(value) : '', placeholder: 'g', class: 'g',
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

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'źródło'; } };

function itemRow(it, { onGrams, onDelete, onEdit }) {
  const rk = h('span', { class: 'rk' });
  const meta = h('small', { class: 'meta' });
  const upd = () => {
    const v = nutr(it, it.g);
    rk.textContent = fmt(v.k);
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

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text) return;
  // The "Czy chodzi o…" sheet only appears when at least one part is a confident match; a weak
  // keyword hit (an ingredient of a dish, say) is not worth interrupting for, so Claude gets the text.
  const segs = matchText(text, library());
  if (segs.some((x) => x.sure || x.ambiguous)) showMatch(segs);
  else askClaude(text);
});

function clearDraft() { q.value = ''; store.del('draft'); grow(); }

// Known products: pick the match and amount locally; only the rest goes to Claude.
function showMatch(segs) {
  const lib = library();
  // Sure: the product is picked. Ambiguous: the user chooses among the strong candidates. Anything else
  // (a weak keyword hit) goes to Claude.
  const rows = segs.map((x) => ({ ...x, pick: x.sure ? x.strong[0].key : x.ambiguous ? '' : 'web' }));
  const ul = $('#mitems');
  const draw = () => {
    ul.replaceChildren(...rows.map((r) => {
      const sel = h('select', { 'aria-label': 'Produkt dla: ' + r.seg },
        r.pick === '' ? h('option', { value: '' }, 'Wybierz…') : null,
        r.cands.map((c) => h('option', { value: c.key }, c.f.n)),
        h('option', { value: 'web' }, 'Inne: szukaj w sieci'));
      sel.value = r.pick;
      const amt = h('span', { class: 'gw' });
      const upd = () => {
        const f = lib[r.pick];
        if (!f) { amt.replaceChildren(); r.g = 0; return; }
        if (r.g == null || r.gFor !== r.pick) { const a = gramsFor(r.amount, f); r.g = a.g; r.note = a.note; r.gFor = r.pick; }
        const kEl = h('span', { class: 'rk' }, fmt(nutr(f, r.g).k));
        amt.replaceChildren(gramInput(r.g, (g) => { r.g = g; kEl.textContent = fmt(nutr(f, g).k); drawButtons(); }, 'gramy: ' + f.n), h('span', {}, 'g'), kEl);
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
  const drawButtons = () => {
    const web = rows.filter((r) => r.pick === 'web').length;
    ok.disabled = rows.some((r) => r.pick !== 'web' && !r.g);  // an unpicked ("Wybierz…") row has no grams yet
    ok.textContent = web ? `Dodaj i szukaj ${web === rows.length ? '' : 'reszty '}w sieci` : 'Dodaj';
  };
  const ok = $('#mok');
  draw();
  const dlg = $('#match');
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    let added = 0;
    for (const r of rows) {
      const f = lib[r.pick];
      if (!f || !r.g) continue;
      day.items.push({ n: f.n, g: r.g, k: f.k, p: f.p, f: f.f, s: f.s, b: f.b, sl: f.sl, cat: f.cat || '', vf: f.vf || false, url: f.url || '', src: f.src || 'moje produkty', note: r.note || '', id: Date.now() + Math.random() });
      remember({ ...f, key: r.pick, g: r.g }, aliasOf(r.seg));
      added++;
    }
    if (added) { saveDay(); render(); }
    const rest = rows.filter((r) => r.pick === 'web').map((r) => r.seg);
    if (rest.length) askClaude(rest.join(', '));
    else { clearDraft(); toast(`Dodano ${added} z moich produktów, bez zapytania do API.`); }
  };
  dlg.showModal();
}

// --- lookups ----------------------------------------------------------------------
// A description that needs Claude appears at once as a row in "Dodatkowe" with a spinner, and the
// result replaces it in place. Several lookups can run side by side, and a result always lands on
// the day it was typed for, even if another day is on screen by then.
const STEPS = ['Szukam wartości w sieci…', 'Sprawdzam źródła…', 'Przeliczam porcje…', 'Jeszcze chwila…'];
const plPos = (n) => (n === 1 ? '1 pozycję' : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? `${n} pozycje` : `${n} pozycji`);

function pendingRow(p) {
  const st = h('span', {}, p.err || STEPS[p.step]);
  p.stEl = st;
  return h('li', { class: 'item pend' + (p.err ? ' err' : ''), 'aria-busy': String(!p.err) },
    h('div', { class: 'ihead' },
      h('span', { class: 'iname' }, p.text),
      p.err ? h('button', { type: 'button', class: 'chip', onclick: () => { runLookup(p); renderItems(); } }, 'Ponów') : null,
      h('button', {
        type: 'button', class: 'icon del', 'aria-label': p.err ? 'Usuń' : 'Przerwij szukanie',
        onclick: () => { if (p.err) { pending.splice(pending.indexOf(p), 1); renderItems(); } else p.ctl.abort(); },
      }, '×')),
    h('small', { class: 'meta' }, p.err ? null : h('i', { class: 'spin' }), st));
}

function askClaude(text) {
  if (!store.get('apikey', '')) { openSettings('Wpisz klucz API, żeby liczyć wartości z opisu.'); return; }
  const p = { id: Date.now() + Math.random(), dayKey: keyOf(cur), text, step: 0, err: '' };
  pending.push(p);
  clearDraft();
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
  }, 12000);
  try {
    const { items, cost } = await analyze({ apiKey: store.get('apikey', ''), model: currentModel(), text: p.text, signal: p.ctl.signal });
    addCost(cost);
    finishLookup(p, items, cost);
  } catch (err) {
    clearInterval(p.timer);
    if (p.ctl.signal.aborted) {
      pending.splice(pending.indexOf(p), 1);
      if (!q.value) { q.value = p.text; store.set('draft', p.text); grow(); } // give the text back for editing
    } else {
      p.err = friendlyError(err);
    }
    renderItems();
  }
}

function finishLookup(p, items, cost) {
  clearInterval(p.timer);
  pending.splice(pending.indexOf(p), 1);
  const added = items.map((x) => ({
    id: Date.now() + Math.random(), n: x.name, g: Math.round(x.grams), pc: Math.round(x.piece_grams) || 0,
    k: x.kcal, p: x.protein, f: x.fat, s: x.saturated_fat, b: x.fibre, sl: x.salt,
    cat: x.category === 'none' ? '' : x.category, vf: x.veg_fruit_g, url: x.source_url, src: x.source_name, note: x.note,
  }));
  // Results are kept as products. A single result is the dish the user described: their own words
  // become its alias, so "owsianka z bananem" finds it locally next time.
  const created = added.map((it) => remember(it, added.length === 1 ? aliasOf(p.text) : '')).filter((r) => r.created).map((r) => r.key);
  addItemsToDay(p.dayKey, added);
  if (p.dayKey === keyOf(cur)) $('#items').lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  toast(`Dodano ${plPos(added.length)}`, 'Cofnij', () => {
    removeItemsFromDay(p.dayKey, added.map((it) => it.id));
    const foods = allFoods();
    for (const key of created) foods[key] = { del: true, upd: Date.now() };
    saveFoods(foods);
  });
}

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

const monthKey = () => 'cost:' + keyOf(new Date()).slice(0, 7);
function addCost(usd) { store.set(monthKey(), store.get(monthKey(), 0) + usd); }
const usd = (x) => x.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + ' $';

// --- add by hand / edit an item ----------------------------------------------------
const MF = { n: '#mn', g: '#mg', k: '#mk', p: '#mp', f: '#mf', s: '#ms', b: '#mb', sl: '#msl' };
$('#manualbtn').onclick = () => openItemDialog(null);

// Category chips (no native picker: a <select> inside a sheet opened misplaced on iOS).
const catBox = $('#mcat');
const setCat = (v) => { for (const b of catBox.children) b.setAttribute('aria-checked', String(b.dataset.v === (v || ''))); };
const getCat = () => [...catBox.children].find((b) => b.getAttribute('aria-checked') === 'true')?.dataset.v || '';
catBox.onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) setCat(b.dataset.v); };

// One sheet for both: adding a product by hand (editing = null) and correcting an item already logged.
// Values are per 100 g; the amount eaten is separate. Everything saved here also goes into "moje
// produkty", so the next description finds it locally.
function openItemDialog(editing) {
  const lib = library();
  const dlg = $('#manual');
  const sug = $('#msug');
  let picked = null; // product chosen from the suggestions
  $('#mtitle').textContent = editing ? 'Edytuj pozycję' : 'Dodaj ręcznie';
  $('#mnoterow').hidden = !editing;
  $('#msubmit').textContent = editing ? 'Zapisz' : 'Dodaj';
  $('#mform').reset();
  setCat('');
  sug.hidden = true;

  const fill = (f) => {
    for (const c of ['n', ...NUT]) $(MF[c]).value = f[c] ?? '';
    $('#mvf').value = vfShare(f.vf) || '';
    setCat(f.cat || '');
  };
  const pick = (s) => {
    picked = s;
    fill(s.f);
    $('#mg').value = s.f.last || s.f.pc || '';
    sug.hidden = true;
    $('#mg').focus();
  };

  if (editing) {
    fill(editing);
    $('#mg').value = editing.g || '';
    $('#mnote').value = editing.note || '';
    $('#mn').oninput = null;
  } else {
    // Autocomplete: nothing is listed until a fragment matches something in the library.
    $('#mn').oninput = () => {
      if (picked && picked.f.n !== $('#mn').value) picked = null;
      const list = suggest($('#mn').value, lib);
      sug.replaceChildren(...list.map((x) => h('li', {},
        h('button', { type: 'button', onclick: () => pick(x) }, h('span', {}, x.f.n), h('small', {}, `${fmt(x.f.k)} kcal`)))));
      sug.hidden = !list.length;
    };
  }

  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const n = $('#mn').value.trim();
    if (!n) return;
    const vals = { n, g: num($('#mg').value), vf: Math.min(100, num($('#mvf').value)), cat: getCat() };
    // An empty salt field means "unknown" (flagged in the day's salt bar), not zero.
    for (const c of NUT) vals[c] = c === 'sl' && $(MF.sl).value === '' ? undefined : num($(MF[c]).value);
    let it = editing;
    if (editing) {
      Object.assign(editing, vals, { note: $('#mnote').value.trim() });
    } else {
      it = { ...vals, id: Date.now() };
      if (picked && picked.f.n === n) Object.assign(it, { url: picked.f.url || '', src: picked.f.src || 'moje produkty' });
      else it.src = 'etykieta';
      day.items.push(it);
    }
    remember({ ...it });
    saveDay(); render();
  };
  dlg.showModal();
  if (!editing) $('#mn').focus();
}

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
  $('#ghtoken').value = store.get('ghtoken', '');
  $('#ghrepo').value = store.get('ghrepo', '');
  $('#ghrepo').placeholder = DEFAULT_REPO;
  drawSync();
  $('#scost').textContent = `Wydane w tym miesiącu (szacunek z tej aplikacji): ${usd(store.get(monthKey(), 0))}`;
  renderLib();
  drawFill();
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const key = $('#skey').value.trim();
    if (key) store.set('apikey', key); else store.del('apikey');
    store.set('llm', $('#smodel').value);
    if (applySync()) sync.start({ full: true });
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
  const btn = $('#sfill'), msg = $('#sfillmsg');
  btn.disabled = true; btn.textContent = 'Uzupełniam z sieci…'; msg.hidden = true;
  try {
    const text = 'Fill in the values for these products. Return exactly one item per line, in this order, '
      + 'keeping each name exactly as written, grams 100:\n' + list.map(([, f]) => '- ' + f.n).join('\n');
    const { items, cost } = await analyze({ apiKey, model: currentModel(), text });
    addCost(cost);
    const foods = allFoods();
    const fixed = {};
    list.forEach(([key, f], i) => {
      const x = items.find((it) => it.name.toLowerCase() === f.n.toLowerCase()) || items[i];
      if (!x) return;
      foods[key] = { ...foods[key], sl: x.salt, cat: x.category === 'none' ? '' : x.category, upd: Date.now() };
      fixed[f.n.toLowerCase()] = foods[key];
    });
    saveFoods(foods);
    for (const k of store.keys('day:')) {
      const d = store.get(k, null);
      let changed = false;
      for (const it of d?.items || []) {
        const f = fixed[it.n.toLowerCase()];
        if (f && it.sl == null) { it.sl = f.sl; it.cat = f.cat; changed = true; }
      }
      if (changed) { d.upd = Date.now(); store.set(k, d); sync.dirtyDay(k.slice(4)); }
    }
    loadDay(); render();
    msg.textContent = `Uzupełnione produkty: ${Object.keys(fixed).length} · ≈ ${usd(cost)}`; msg.hidden = false;
  } catch (err) {
    msg.textContent = friendlyError(err); msg.hidden = false;
  } finally {
    btn.disabled = false;
    drawFill();
  }
};

function renderLib() {
  const foods = customFoods();
  const keys = Object.keys(foods).sort((a, b) => a.localeCompare(b, 'pl'));
  $('#slib').replaceChildren(...(keys.length ? keys.map((k) => h('li', {},
    h('span', { class: 'nm' }, foods[k].n, h('small', { class: 'meta' }, `${fmt(foods[k].k)} kcal / 100 g`)),
    h('button', { type: 'button', class: 'icon del', 'aria-label': 'Usuń: ' + foods[k].n, onclick: () => {
      const all = allFoods(); all[k] = { del: true, upd: Date.now() }; saveFoods(all); renderLib();
    } }, '×'))) : [h('li', { class: 'empty' }, 'Jeszcze nic. Produkty dodane z opisu lub ręcznie pojawią się tutaj.')]));
}

$('#sexport').onclick = async () => {
  const data = {};
  for (const k of [...store.keys('day:'), 'foods']) {
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
    const keys = Object.keys(data).filter((k) => k === 'ft:foods' || k.startsWith('ft:day:'));
    if (!keys.length) throw new Error();
    // Merge by `upd`, so an older export never overwrites newer entries.
    let taken = 0;
    for (const k of keys) {
      const rec = JSON.parse(data[k]);
      if (k === 'ft:foods') {
        const { merged, toLocal } = mergeMaps(allFoods(), rec);
        if (toLocal.length) { saveFoods(merged); taken += toLocal.length; }
      } else if ((rec.upd || 0) > (store.get(k.slice(3), null)?.upd || 0) || store.get(k.slice(3), null) == null) {
        store.set(k.slice(3), rec); sync.dirtyDay(k.slice(7)); taken++;
      }
    }
    loadDay(); render(); renderLib();
    toast(taken ? `Zaimportowano wpisów: ${taken}.` : 'Nic do zaimportowania: masz już nowsze dane.');
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
  const token = $('#ghtoken').value.trim();
  const repo = $('#ghrepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
  const changed = token !== store.get('ghtoken', '') || repo !== store.get('ghrepo', '');
  if (token) store.set('ghtoken', token); else store.del('ghtoken');
  if (repo) store.set('ghrepo', repo); else store.del('ghrepo');
  if (changed) sync.resetSynced();
  return changed;
}
$('#syncnow').onclick = async () => {
  applySync();
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

// --- start ------------------------------------------------------------------------
loadDay();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
