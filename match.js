// Deterministic matching of a meal description against the local product library,
// so known products skip the API call entirely.

const STOP = new Set(['z', 'ze', 'i', 'oraz', 'na', 'do', 'w', 'we', 'po', 'od', 'bez', 'okolo', 'ok', 'troche', 'kawalek', 'porcja', 'porcji', 'szt', 'sztuki', 'sztuk', 'sztuka', 'gram', 'gramow', 'g', 'kg', 'ml']);

// Unit words → grams per unit. Rough household measures; the user corrects grams in the sheet.
const UNITS = [
  [/^lyzecz/, 5, 'łyżeczka'],
  [/^lyz/, 15, 'łyżka'],
  [/^szklan/, 250, 'szklanka'],
  [/^kubek|^kubk/, 250, 'kubek'],
  [/^kromk/, 35, 'kromka'],
  [/^plaster|^plastr/, 15, 'plaster'],
  [/^garsc/, 30, 'garść'],
];
const WORD_NUM = [[/^pol$/, 0.5], [/^jed/, 1], [/^dw/, 2], [/^trz/, 3], [/^czter/, 4], [/^piec/, 5], [/^szesc/, 6]];

const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
const words = (s) => fold(s).replace(/\(.*?\)/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
// Four-letter prefixes absorb most Polish inflection: jajko/jajka/jajek → "jajk", skyr/skyru → "skyr".
const stems = (s) => [...new Set(words(s).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d/.test(w)).map((w) => w.slice(0, 4)))];

export function splitSegments(text) {
  return text.split(/[,;\n+]|\s(?:i|oraz|plus)\s/i).map((s) => s.trim()).filter(Boolean);
}

// Amount in a segment: grams ("200 g", "0,5 kg"), a unit ("2 łyżki") or a count ("2 jajka", "pół").
export function parseAmount(seg) {
  const f = fold(seg);
  let m = f.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|gram\w*|ml|l)\b/);
  if (m) {
    const n = parseFloat(m[1].replace(',', '.'));
    return { grams: m[2] === 'kg' || m[2] === 'l' ? n * 1000 : n };
  }
  const ws = f.split(/[^a-z0-9.,]+/).filter(Boolean);
  let count = null;
  for (const w of ws) {
    if (/^\d+(?:[.,]\d+)?$/.test(w)) { count = parseFloat(w.replace(',', '.')); break; }
    const wn = WORD_NUM.find(([re]) => re.test(w));
    if (wn) { count = wn[1]; break; }
  }
  for (const w of ws) {
    const u = UNITS.find(([re]) => re.test(w));
    if (u) return { grams: (count ?? 1) * u[1], note: `${fmtN(count ?? 1)} × ${u[2]} ≈ ${u[1]} g` };
  }
  return count != null ? { count } : {};
}
const fmtN = (n) => String(n).replace('.', ',');

// Short words keep a 3-letter stem (ryż → "ryz"), so compare as prefixes: "ryz" matches "ryze" (ryżem).
const same = (a, b) => a.startsWith(b) || b.startsWith(a);

function score(segStems, food) {
  const fs = stems([food.n, ...(food.alias || [])].join(' '));
  const nameStems = stems(food.n);
  if (!segStems.length || !fs.length) return 0;
  const hit = segStems.filter((s) => fs.some((x) => same(s, x))).length;
  if (!hit) return 0;
  const nameHit = nameStems.filter((s) => segStems.some((x) => same(s, x))).length;
  // Half: how much of the description is explained; half: how much of the product name was mentioned.
  return (hit / segStems.length + Math.max(nameHit / nameStems.length, hit / fs.length)) / 2;
}

// For each segment: candidates from the library (best first) and the parsed amount.
export function matchText(text, lib) {
  return splitSegments(text).map((seg) => {
    const ss = stems(seg);
    const cands = Object.entries(lib)
      .map(([key, f]) => ({ key, f, score: score(ss, f) }))
      .filter((c) => c.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    return { seg, amount: parseAmount(seg), cands, sure: cands.length > 0 && cands[0].score >= 0.75 && (cands.length === 1 || cands[1].score < cands[0].score) };
  });
}

// Grams for a chosen product: explicit grams, else count × piece weight, else the last amount eaten.
export function gramsFor(amount, f) {
  if (amount.grams) return { g: Math.round(amount.grams), note: amount.note || '' };
  const n = amount.count ?? 1;
  if (f.pc) return { g: Math.round(n * f.pc), note: `${fmtN(n)} szt. × ${f.pc} g` };
  if (f.last) return { g: Math.round(n * f.last), note: n === 1 ? 'jak ostatnio' : `${fmtN(n)} × ostatnia porcja` };
  return { g: 100, note: 'ilość do sprawdzenia' };
}

export const aliasOf = (seg) => words(seg).filter((w) => !/^\d/.test(w) && !STOP.has(w)).join(' ');
