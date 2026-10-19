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
const WORD_NUM = [[/^pol$/, 0.5], [/^(jeden|jedna|jedno)$/, 1], [/^(dwa|dwie)$/, 2], [/^trzy$/, 3], [/^cztery$/, 4], [/^piec$/, 5], [/^szesc$/, 6]];

const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
const words = (s) => fold(s).replace(/\(.*?\)/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
// Four-letter prefixes absorb most Polish inflection: jajko/jajka/jajek → "jajk", skyr/skyru → "skyr".
// Words that carry the food's identity: no amounts, units ("kromki", "łyżka") or number words.
const keyWords = (s) => [...new Set(words(s).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d/.test(w)
  && !UNITS.some(([re]) => re.test(w)) && !WORD_NUM.some(([re]) => re.test(w))))];
const stems = (s) => [...new Set(keyWords(s).map((w) => w.slice(0, 4)))];

// Splits a description into foods. A dish lists its ingredients after "z"/"ze" ("owsianka z bananem,
// skyrem, borówkami") or after a leading weight ("195 g: owsianka …"): the ingredients belong to the
// dish and are not extra portions, and where the dish ends is not something a splitter can tell
// ("owsianka z bananem, 2 jajka" is two foods). So the whole text stays ONE segment, which only
// matches locally when it matches a saved dish; otherwise Claude splits it.
export function splitSegments(text) {
  if (/^\s*\d+(?:[.,]\d+)?\s*(?:kg|g|gr|ml|l)\s*:/i.test(text) || /(^|[\s,;])ze?\s/i.test(text)) return [text.trim()];
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

// How well a product explains a description. cover: share of the description's words found in the
// product (name, aliases); nameCov: share of the product's name that was mentioned.
function score(segStems, segWords, food) {
  const fsWords = keyWords([food.n, ...(food.alias || [])].join(' '));
  const fs = stems([food.n, ...(food.alias || [])].join(' '));
  const nameStems = stems(food.n);
  if (!segStems.length || !fs.length) return null;
  const hit = segStems.filter((s) => fs.some((x) => same(s, x))).length;
  if (!hit) return null;
  const nameHit = nameStems.filter((s) => segStems.some((x) => same(s, x))).length;
  const cover = hit / segStems.length;
  const nameCov = Math.max(nameHit / nameStems.length, hit / fs.length);
  // Whole words that match exactly ("owsianka" = owsianka, but not owsiane) break ties between stems.
  const exact = segWords.filter((w) => fsWords.includes(w)).length / segWords.length;
  return { score: (cover + nameCov) / 2 + 0.2 * exact, cover, nameCov };
}

// For each segment: candidates from the library (best first) and the parsed amount.
//   sure:      one product clearly explains the text (it covers at least 75% of its words and is not tied)
//   strong:    the products that cover at least 75% of the words, best first
//   ambiguous: several products explain it equally well (jajka / masło orzechowe for "orzechy")
// A product that only shares a word with a longer description (banan in "owsianka z bananem")
// is a candidate at most, never sure.
export function matchText(text, lib) {
  return splitSegments(text).map((seg) => {
    const ss = stems(seg), sw = keyWords(seg);
    const cands = Object.entries(lib)
      .map(([key, f]) => ({ key, f, ...score(ss, sw, f) }))
      .filter((c) => c.score >= 0.5)
      .sort((a, b) => b.score - a.score || b.cover - a.cover);
    const strong = cands.filter((c) => c.cover >= 0.75);
    const sure = strong.length === 1 || (strong.length > 1 && strong[0].score - strong[1].score >= 0.1);
    return {
      seg, amount: parseAmount(seg), cands: cands.slice(0, 4), sure,
      ambiguous: !sure && strong.length > 1,
      strong: strong.slice(0, 4),
    };
  });
}

// Grams for a chosen product: explicit grams, else count × piece weight, else the last amount eaten.
export function gramsFor(amount, f) {
  if (amount.grams) return { g: Math.round(amount.grams), note: amount.note || '' };
  const n = amount.count ?? 1;
  if (f.pc) return { g: Math.round(n * f.pc), note: `${fmtN(n)} szt. × ${f.pc} g` };
  if (f.last) return { g: Math.round(n * f.last), note: n === 1 ? 'jak ostatnio' : `${fmtN(n)} × ostatnia porcja` };
  return { g: 0, note: 'podaj ilość' };
}

export const aliasOf = (seg) => words(seg).filter((w) => !/^\d/.test(w) && !STOP.has(w)).join(' ');
