// Runs the same descriptions through several models and shows the values, cost and token use side by side.
import { analyze, friendlyError } from './llm.js';

const $ = (s) => document.querySelector(s);
const get = (k, d) => { try { const v = localStorage.getItem('ft:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem('ft:' + k, JSON.stringify(v)); } catch {} };
const fmt = (x, d = 0) => (Math.round(x * 10 ** d) / 10 ** d).toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (x) => x.toLocaleString('pl-PL', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' $';
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) el.append(c);
  return el;
}

const CASES = [
  '2 jajka sadzone na łyżeczce oliwy',
  'Skyr naturalny Piątnica 150 g',
  'zapiekana owsianka z bananem, skyrem i borówkami | 195',
  'kebab w bułce, średni',
  'latte na mleku 2%, 300 ml',
  'baton Snickers',
];
$('#cases').value = get('testcases', CASES.join('\n'));
// Model and effort pairs; the first of each model is what the app uses.
const CONFIGS = [
  ['claude-haiku-5-5', 'medium'], ['claude-haiku-5-5', 'high'],
  ['claude-sonnet-5-5', 'low'], ['claude-sonnet-5-5', 'medium'],
  ['claude-opus-5-5', 'low'],
].map(([model, effort]) => ({ id: `${model}:${effort}`, model, effort, name: `${model.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2')} · ${effort}` }));
const picked = new Set(get('testcfg', ['claude-haiku-5-5:medium', 'claude-haiku-5-5:high']));
$('#models').replaceChildren(...CONFIGS.map(({ id, name }) => {
  const b = h('button', { type: 'button', role: 'checkbox', 'aria-checked': String(picked.has(id)) }, name);
  b.onclick = () => { picked.has(id) ? picked.delete(id) : picked.add(id); b.setAttribute('aria-checked', String(picked.has(id))); };
  return b;
}));

$('#run').onclick = async () => {
  const apiKey = get('apikey', '');
  if (!apiKey) { $('#status').textContent = 'Najpierw wpisz klucz API w ustawieniach aplikacji.'; return; }
  const models = CONFIGS.filter((c) => picked.has(c.id));
  const cases = $('#cases').value.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [text, g] = l.split('|'); return { text: text.trim(), grams: parseFloat(g) || 0 }; });
  if (!models.length || !cases.length) return;
  set('testcases', $('#cases').value); set('testcfg', models.map((c) => c.id));
  $('#run').disabled = true;
  const sums = Object.fromEntries(models.map((c) => [c.id, { cost: 0, ms: 0, n: 0 }]));
  const out = $('#out');
  out.replaceChildren();
  let done = 0;
  const total = cases.length * models.length;
  $('#status').textContent = `0 / ${total}`;
  for (const c of cases) {
    const tbody = h('tbody');
    out.append(h('section', { class: 'card' },
      h('h3', {}, c.text + (c.grams ? ` · ${c.grams} g` : '')),
      h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Model', 'Pozycja', 'g', 'kcal', 'B', 'T', 'nas.', 'bł.', 'sól', 'źródło', 'wej./wyj.', 'wysz.', 'czas', 'koszt'].map((x) => h('th', {}, x)))),
        tbody))));
    // Models run in parallel for one case; cases one after another, so the page fills in steadily.
    await Promise.all(models.map(async (cfg) => {
      const t0 = performance.now();
      const short = cfg.name;
      try {
        const r = await analyze({ apiKey, model: cfg.model, effort: cfg.effort, text: c.text, grams: c.grams });
        const ms = performance.now() - t0;
        const sum = sums[cfg.id];
        Object.assign(sum, { cost: sum.cost + r.cost, ms: sum.ms + ms, n: sum.n + 1 });
        record(r.cost);
        r.items.forEach((x, i) => tbody.append(h('tr', { class: i ? '' : 'first' },
          h('td', {}, i ? '' : short), h('td', { title: x.note }, x.name), h('td', {}, fmt(x.grams)), h('td', {}, fmt(x.kcal)),
          h('td', {}, fmt(x.protein, 1)), h('td', {}, fmt(x.fat, 1)), h('td', {}, fmt(x.saturated_fat, 1)), h('td', {}, fmt(x.fibre, 1)),
          h('td', {}, fmt(x.salt, 2)), h('td', { title: x.source_url }, x.source_name),
          h('td', {}, i ? '' : `${fmt(r.usage.in / 1000, 1)}k / ${fmt(r.usage.out / 1000, 1)}k`), h('td', {}, i ? '' : String(r.usage.searches)),
          h('td', {}, i ? '' : `${fmt(ms / 1000, 0)} s`), h('td', {}, i ? '' : usd(r.cost)))));
      } catch (err) {
        if (err.cost) record(err.cost);
        tbody.append(h('tr', { class: 'first' }, h('td', {}, short), h('td', { colspan: '13', class: 'err' }, friendlyError(err))));
      }
      $('#status').textContent = `${++done} / ${total}`;
    }));
  }
  out.prepend(h('section', { class: 'card' }, h('h3', {}, 'Podsumowanie'), h('table', {},
    h('thead', {}, h('tr', {}, ['Model', 'koszt razem', 'średnio / opis', 'średni czas'].map((x) => h('th', {}, x)))),
    h('tbody', {}, models.map(({ id, name }) => { const m = sums[id]; return h('tr', {}, h('td', {}, name), h('td', {}, usd(m.cost)),
      h('td', {}, m.n ? usd(m.cost / m.n) : '—'), h('td', {}, m.n ? `${fmt(m.ms / m.n / 1000, 0)} s` : '—')); })))));
  $('#run').disabled = false;
};

// Test runs count toward the month total shown in the app.
function record(cost) {
  const d = new Date();
  const k = `cost:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  set(k, get(k, 0) + cost);
}
