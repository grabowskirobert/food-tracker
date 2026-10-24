// Plan data from teach/zdrowie lessons/0001 (jadłospis na 8 tygodni).
// Foods: values per 100 g. k kcal, p protein, f fat, s saturated fat, b fibre (g); vf counts toward veg & fruit;
// pc grams per piece, for amounts given as a count; sl salt (g, typical values, not from labels);
// cat fish | legumes | red_meat for the weekly counts.
export const FOODS = {
  oats: {"n": "Płatki owsiane (suche)", "k": 370, "p": 13, "f": 7, "s": 1.2, "b": 10, "vf": false, "sl": 0},
  skyr: {"n": "Skyr naturalny", "k": 63, "p": 11, "f": 0.2, "s": 0.1, "b": 0, "vf": false, "sl": 0.1},
  banana: {"n": "Banan", "k": 90, "p": 1, "f": 0.3, "s": 0.1, "b": 2.6, "vf": true, "pc": 120, "sl": 0},
  apple: {"n": "Jabłko", "k": 52, "p": 0.3, "f": 0.2, "s": 0, "b": 2.4, "vf": true, "pc": 150, "sl": 0},
  berries: {"n": "Owoce jagodowe (mrożone)", "k": 50, "p": 0.7, "f": 0.3, "s": 0, "b": 2.5, "vf": true, "sl": 0},
  walnut: {"n": "Orzechy włoskie", "k": 650, "p": 15, "f": 65, "s": 6, "b": 7, "vf": false, "sl": 0},
  almond: {"n": "Migdały", "k": 580, "p": 21, "f": 50, "s": 3.8, "b": 12.5, "vf": false, "sl": 0},
  chicken: {"n": "Pierś z kurczaka (surowa)", "k": 110, "p": 23, "f": 1.5, "s": 0.4, "b": 0, "vf": false, "sl": 0.15},
  salmon: {"n": "Łosoś (surowy)", "k": 200, "p": 20, "f": 13, "s": 3, "b": 0, "vf": false, "sl": 0.1, "cat": "fish"},
  rice: {"n": "Ryż brązowy (suchy)", "k": 360, "p": 7.5, "f": 2.7, "s": 0.5, "b": 3.5, "vf": false, "sl": 0},
  potato: {"n": "Ziemniaki (gotowane)", "k": 85, "p": 2, "f": 0.1, "s": 0, "b": 1.8, "vf": false, "sl": 0},
  veg: {"n": "Warzywa (mieszane)", "k": 30, "p": 2, "f": 0.3, "s": 0, "b": 2.5, "vf": true, "sl": 0.05},
  rapeseed: {"n": "Olej rzepakowy", "k": 884, "p": 0, "f": 100, "s": 7, "b": 0, "vf": false, "sl": 0},
  olive: {"n": "Oliwa z oliwek", "k": 884, "p": 0, "f": 100, "s": 14, "b": 0, "vf": false, "sl": 0},
  rye: {"n": "Chleb razowy", "k": 240, "p": 8, "f": 1.5, "s": 0.3, "b": 7, "vf": false, "sl": 1.1},
  egg: {"n": "Jajka (całe)", "k": 143, "p": 12.6, "f": 9.5, "s": 3.1, "b": 0, "vf": false, "pc": 60, "sl": 0.35},
  quark: {"n": "Twaróg chudy", "k": 100, "p": 19, "f": 1, "s": 0.6, "b": 0, "vf": false, "sl": 0.1},
  pbutter: {"n": "Masło orzechowe 100%", "k": 590, "p": 25, "f": 50, "s": 10, "b": 6, "vf": false, "sl": 0},
  lentil: {"n": "Soczewica (sucha)", "k": 350, "p": 25, "f": 1.1, "s": 0.2, "b": 11, "vf": false, "sl": 0, "cat": "legumes"}
};

// Meal items: [food id, grams].
export const PLANS = {
  A: { name: "Dzień A", meals: [
    { name: "Śniadanie", items: [["oats", 80], ["skyr", 150], ["banana", 120], ["walnut", 20]] },
    { name: "Obiad", items: [["chicken", 130], ["rice", 120], ["veg", 250], ["rapeseed", 10]] },
    { name: "Przekąska", items: [["quark", 100], ["apple", 150], ["almond", 25]] },
    { name: "Kolacja", items: [["rye", 80], ["egg", 120], ["veg", 120], ["olive", 10], ["pbutter", 20]] }
  ] },
  B: { name: "Dzień B", meals: [
    { name: "Śniadanie", items: [["oats", 80], ["skyr", 150], ["banana", 120], ["walnut", 20]] },
    { name: "Obiad (ryba)", items: [["salmon", 150], ["potato", 450], ["veg", 200], ["rapeseed", 10]] },
    { name: "Przekąska", items: [["quark", 100], ["berries", 150], ["almond", 25]] },
    { name: "Kolacja (strączkowe)", items: [["lentil", 60], ["rye", 70], ["veg", 120], ["olive", 10]] }
  ] }
};

// kcal [min, max], protein [min], satpct [max % of energy], fibre [min, max], vf [min g], salt [max g] (NCEŻ).
export const TARGETS = {"kcal": [2250, 2550], "protein": [110], "satpct": [7], "fibre": [25, 40], "vf": [400], "salt": [5]};

// Per week (NCEŻ, lesson 1): fish 2×, legumes 2–3× (days eaten), red meat and cold cuts together ≤ 500 g.
export const WEEK = { fish: 2, legumes: 2, red_meat: 500, sweet: 2 };

// "Co zmienić": short rules shown in the app, from the log of 18–24.10 (saturated fat averaged 34 g/day against a 19 g limit).
export const TIPS = [
  ['Masło → oliwa lub olej rzepakowy', '10 g masła to ok. 5 g nasyconych, 10 g oliwy ok. 1 g. Dotyczy jajecznicy, tostów i kanapek.'],
  ['Serek śmietankowy → twaróg, skyr, hummus', '70 g Almette to ok. 12 g nasyconych, czyli ponad połowa dziennego limitu 19 g.'],
  ['Słodycze: najwyżej 2 porcje w tygodniu', 'Ciasta, ciastka, batony, czekolada, słodkie napoje. „Bez cukru” nie obniża tłuszczu ani kcal: cynamonka na ksylitolu to nadal 340–540 kcal.'],
  ['Wołowina najwyżej raz w tygodniu', 'NCEŻ: czerwone mięso razem z wędlinami najwyżej 500 g tygodniowo (źródło nie mówi, czy to waga surowa; aplikacja liczy wagę zjedzoną). Na obiad częściej ryba, kurczak, strączkowe.'],
];
// Shown next to the red marker on a metric that is over its limit.
export const OVER_HINT = {
  s: 'Najczęściej: masło, serek śmietankowy, ciasta i słodycze, wołowina, tłuste sery.',
  sl: 'Najczęściej: wędliny, sery, pieczywo, gotowe sosy i pesto. Suma jest zaniżona, jeśli którejś pozycji brakuje soli.',
};

// Category by name, applied when no category is stored (the model said "none", or an old item has none).
// Deterministic backstop for the model: it never overrides a stored category except for the VETO cases.
const RULES = [
  ['sweet', /ciast|ciacho|ciastk|czekolad|baton|cukierk|żelk|lody\b|lód|wafel|pączek|drożdżówk|cynamonk|sernik|brownie|muffin|donut|chałw|ptasie mleczko|mirinda|fanta|sprite|coca|cola\b|pepsi|oranżad|nektar|syrop/i],
  ['red_meat', /wołow|wieprzow|schab|szynk|kiełbas|boczek|karkówk|parówk|salami|pasztet|baranin|cielęcin|bitk|zraz|polędwic|żeberk|kabanos|mortadel|golonk|stek\b|burger|kebab/i],
  ['fish', /łosoś|łosos|dorsz|tuńczyk|śledź|śledz|makrel|sardyn|pstrąg|mintaj|halibut|sandacz|szprot|krewetk|\bryb/i],
  ['legumes', /soczewic|ciecierzyc|fasol|groch|tofu|hummus|edamame|\bbób/i],
];
// Poultry in the name turns a cold cut or burger into non-red meat; soy drinks and green beans are not legumes; juice is not a sweet.
const VETO = { red_meat: /indyk|kurczak|drób|drobi|kaczk|gęś/i, legumes: /mleko|napój|jogurt|sos sojow|szparagow|zielon/i, sweet: /\bsok\b|soku|owoc(owy|e|ów)?\b.*\bmus\b|^mus owocowy/i };
export function ruleCat(name = '') {
  for (const [cat, re] of RULES) if (re.test(name) && !VETO[cat]?.test(name)) return cat;
  return '';
}
// Effective category: a stored one wins, 'none' means the user said "other", an empty one falls back to the name rules.
export const catOf = (it) => (it.cat === 'none' ? '' : it.cat && !(VETO[it.cat]?.test(it.n || '') && it.cat === 'legumes') ? it.cat : ruleCat(it.n));

// Values per 100 g that cannot be right: flagged in the list so the item gets checked, never silently changed.
export function suspect(it) {
  const k = +it.k || 0, p = +it.p || 0, f = +it.f || 0, s = +it.s || 0;
  if (s > f + 0.5) return 'nasycone > tłuszcz';
  if (p + f > 100.5) return 'białko + tłuszcz > 100 g';
  if (k > 900) return 'kcal > 900 / 100 g';
  if (k > 0 && k < 0.85 * (4 * p + 9 * f) - 5) return 'kcal za niskie wobec białka i tłuszczu';
  return '';
}
// A mixed plate counted whole as red meat: asks for the grams of meat alone.
export const needsShare = (it) => catOf(it) === 'red_meat' && !(it.cs > 0) && /ziemniak|surówk|ryż|kasz|makaron|frytk|sałat|warzyw|sos\b|z (ryżem|kasz)/i.test(it.n || '');
