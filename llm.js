// Turns a meal description or photo into food items with values per 100 g.
// Claude answers from its knowledge of nutrition tables and searches the web only for branded products;
// the result comes back through the zapisz_produkty tool so it is always schema-valid JSON.
import Anthropic from './vendor/anthropic-sdk-0.131.0.mjs';

export const MODELS = [
  ['claude-haiku-5-5', 'Claude Haiku 5.5 (najtańszy)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (najdokładniejszy)'],
];

// USD per million tokens [input, output, cache read]; web search is $10 per 1000 searches.
// Haiku 5.5 bills prompts over 100k tokens at 5× these rates.
const PRICES = {
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-opus-5-5': [4, 20, 0.2],
};
const SEARCH_USD = 0.01;
const isHaiku = (model) => model.startsWith('claude-haiku');

function costOf(model, u) {
  const pr = PRICES[model] || PRICES['claude-sonnet-5-5'];
  const x = isHaiku(model) && u.in + u.cacheR > 100000 ? 5 : 1;
  return (u.in * pr[0] + u.out * pr[1] + u.cacheR * pr[2]) * x / 1e6 + u.searches * SEARCH_USD;
}

const NUM = (d) => ({ type: 'number', description: d });

const SAVE_TOOL = {
  name: 'zapisz_produkty',
  description: 'Saves the recognised foods with nutrition values per 100 g. Call it exactly once, at the end.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'grams', 'kcal', 'protein', 'fat', 'saturated_fat', 'fibre', 'salt', 'free_sugar', 'category', 'category_grams', 'veg_fruit_g', 'source_name', 'source_url', 'note'],
          properties: {
            name: { type: 'string', description: 'Polish name of the food or dish including its form, e.g. "Makaron pełnoziarnisty (ugotowany)" or "Zapiekana owsianka z bananem". For a dish this is the dish name, never a list of amounts.' },
            grams: NUM('Amount eaten, in grams'),
            kcal: NUM('kcal per 100 g'),
            protein: NUM('Protein, g per 100 g'),
            fat: NUM('Total fat, g per 100 g'),
            saturated_fat: NUM('Saturated fat, g per 100 g'),
            fibre: NUM('Dietary fibre, g per 100 g'),
            salt: NUM('Salt, g per 100 g (if only sodium is known: sodium × 2.5)'),
            free_sugar: NUM('Free (added) sugars, g per 100 g, WHO definition: sugar, syrups, honey, glucose-fructose syrup added by the maker or cook, plus the sugars of honey, syrups and fruit juice. NOT the sugars naturally inside whole fruit, vegetables, grains, or the lactose of milk, yoghurt, kefir, skyr, quark and other dairy (lactose is never free sugar). Plain dairy without sweetener: 0. From a label take "w tym cukry" and subtract the sugar that comes from milk (about 3.5–4.5 g lactose per 100 g of skyr, yoghurt, kefir, milk; 3 g in quark) or from whole fruit when the ingredients show it; count the rest. If unsure for a non-dairy product, count it all. Xylitol, erythritol and other sweeteners are not sugars. 0 for a product without added sugar.'),
            category: {
              type: 'string',
              enum: ['fish', 'legumes', 'red_meat', 'none'],
              description: 'fish: fish and seafood; legumes: lentils, beans, chickpeas, peas, tofu, edamame (soy milk is none); red_meat: beef, pork, lamb and any cold cuts or sausages (wędliny); none: everything else',
            },
            category_grams: NUM('Grams of THIS item that really belong to its category, as eaten. Equals grams for a plain product. For a dish cooked together, only the weight of the meat, fish or legumes part (e.g. 150 g of pasta with salmon and pesto: about 40 g of salmon). A plate is split into separate items, so its category_grams equals its grams. 0 when the category is none.'),
            veg_fruit_g: NUM('Grams of vegetables and fruit in 100 g of this food: 100 for a plain vegetable or fruit, 0 for none, in between for a dish (potatoes, legumes, juice and dried fruit do not count)'),
            source_name: { type: 'string', description: 'Where the numbers come from, e.g. "USDA", "IŻŻ", "Open Food Facts", "etykieta", "szacunek"' },
            source_url: { type: 'string', description: 'URL of the page the numbers were taken from, or an empty string' },
            note: { type: 'string', description: 'Short Polish note: how the amount was worked out, assumptions, estimated values. For a dish: the main ingredient amounts assumed. At most 200 characters. Empty string if none.' },
          },
        },
      },
    },
  },
};

const SYSTEM = `You convert a meal description, a photo of a meal, or both into nutrition data for a personal food log. The user has high LDL cholesterol, so saturated fat must be accurate.

What was eaten: separate foods ("2 jajka, banan, skyr"), a plate, or a dish cooked together.
- A plate is a main (meat, fish, patties, cutlet) served with sides (potatoes, rice, groats, salad, "surówka", sauce, bread): return one item for the main and one for each side, so the meat has its own grams. Split the portion weight plausibly ("bitki ok. 150 g, ziemniaki 150 g, surówka 80 g") and say how in "note".
- A dish cooked together (zapiekana owsianka z bananem, makaron z łososiem i pesto, bigos, gulasz, kanapka) is one item named for the dish, never one per ingredient. If its category food is only part of it (the salmon in a pasta), set category_grams to that part.
From a photo, recognise the foods on the plate the same way.

Amount eaten: if the user gives the weight of the portion, use it (several foods: split it plausibly and say how in "note"). Otherwise convert pieces, spoons, slices and packages to grams, or estimate the portion from the photo, and say how in "note" (e.g. "2 szt. × 60 g").

Values per 100 g, for the form eaten (raw, dry or cooked):
- Generic foods and common dishes: give the values from your knowledge of USDA FoodData Central and the Polish IŻŻ tables, without searching. source_name "USDA" or "IŻŻ", source_url "".
- Search the web only for a named brand or packaged product, or a dish you do not know. Search at most twice; one reliable page is enough (the manufacturer's label, a shop listing, Open Food Facts). Put that page in source_url.
- For a dish, assume a typical recipe with the ingredients the user named, compute the values per 100 g of the finished dish, set veg_fruit_g to its share of vegetables and fruit, and list the main ingredient amounts in "note".
- Weights are as eaten (cooked), including category_grams.
- free_sugar: lactose from dairy never counts (a plain skyr, yoghurt, milk, kefir or cottage cheese has 0); in a flavoured dairy product count only sugar, honey, syrup or fruit preparation added on top of the milk's lactose.
- free_sugar needs care for cakes, biscuits, bars, drinks, sauces and anything sweet: use the label or recipe, not a guess of total sugar. A home cake: estimate the sugar, honey and syrup in the recipe, and say so in "note".
- If a word looks like a typo of a common food ("midgały" = migdały, almonds), assume the common food and say so in "note"; never pick an exotic reading.
- Name any estimated value in "note"; if the whole item is estimated, source_name "szacunek".

Then call zapisz_produkty once with all items. Names and notes in Polish. No other answer.`;

export function friendlyError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return 'Przerwano.';
  if (err instanceof Anthropic.AuthenticationError) return 'Klucz API jest nieprawidłowy albo został unieważniony.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Klucz nie ma uprawnień do tego modelu lub wyszukiwania w sieci.';
  if (err instanceof Anthropic.RateLimitError) return 'Limit zapytań lub wydatków osiągnięty. Spróbuj za chwilę albo podnieś limit w konsoli.';
  if (err instanceof Anthropic.BadRequestError) return 'Błąd zapytania: ' + (err.error?.error?.message || err.message);
  if (err instanceof Anthropic.APIConnectionError) return 'Brak połączenia z API. Sprawdź internet.';
  if (err instanceof Anthropic.APIError) return 'Błąd API (' + err.status + '). Spróbuj ponownie.';
  return err?.message || String(err);
}

// Haiku has no dynamic-filtering search and no server-side refusal fallback.
// Default effort: high on Haiku (as cheap as medium there, steadier portions), low on Sonnet and Opus;
// the comparison page overrides it.
export const defaultEffort = (model) => (isHaiku(model) ? 'high' : 'low');
function requestFor(model, effort = defaultEffort(model)) {
  const where = { type: 'approximate', country: 'PL', timezone: 'Europe/Warsaw' };
  if (isHaiku(model)) {
    return {
      output_config: { effort },
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2, user_location: where }, SAVE_TOOL],
    };
  }
  return {
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2, user_location: where }, SAVE_TOOL],
  };
}

// text: what was eaten (may be empty with a photo). grams: weight of the whole portion, or 0.
// image: { data: base64, media_type } or null.
// Returns { items, cost, usage } where cost is the estimated USD price and usage the token counts.
export async function analyze({ apiKey, model, effort, text = '', grams = 0, image = null, signal }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let prompt = `What I ate:\n${text.trim() || (image ? '(see the photo)' : '')}`;
  if (grams > 0) prompt += `\n\nWeight of the whole portion: ${grams} g.`;
  const content = image
    ? [{ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } }, { type: 'text', text: prompt }]
    : prompt;
  const messages = [{ role: 'user', content }];
  const usage = { in: 0, out: 0, cacheR: 0, searches: 0 };
  const done = () => ({ cost: costOf(model, usage), usage });
  // A web-search turn can stop with pause_turn; resend it to let Claude continue.
  for (let turn = 0; turn < 3; turn++) {
    const msg = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      tool_choice: { type: 'auto' },
      messages,
      ...requestFor(model, effort),
    }, { signal });
    const u = msg.usage || {};
    usage.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    usage.out += u.output_tokens || 0;
    usage.cacheR += u.cache_read_input_tokens || 0;
    usage.searches += u.server_tool_use?.web_search_requests || 0;
    if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Model odmówił odpowiedzi. Opisz posiłek inaczej.'), done());
    const call = msg.content.find((b) => b.type === 'tool_use' && b.name === SAVE_TOOL.name);
    if (call) return { items: call.input.items, ...done() };
    if (msg.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: msg.content });
  }
  throw Object.assign(new Error('Model nie zwrócił wyniku. Spróbuj opisać posiłek dokładniej.'), done());
}

// Downscales a photo to at most `max` px on the long side and returns JPEG base64: a phone photo
// would otherwise be several MB and cost far more input tokens than the model needs.
export async function photoForApi(file, max = 1024) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * s);
  canvas.height = Math.round(bmp.height * s);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.82));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { data: btoa(bin), media_type: 'image/jpeg' };
}
