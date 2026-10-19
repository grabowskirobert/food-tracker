// Turns a free-text meal description into food items with values per 100 g.
// Claude looks the values up with web search; the result comes back through the
// zapisz_produkty tool so it is always schema-valid JSON.
import Anthropic from './vendor/anthropic-sdk-0.131.0.mjs';

export const MODELS = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (domyślny, tańszy)'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (dokładniejszy)'],
];

// USD per million tokens [input, output, cache read]; web search is $10 per 1000 searches.
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-opus-4-8': [5, 25, 0.5],
};
const SEARCH_USD = 0.01;

function costOf(msg) {
  const pr = PRICES[msg.model] || PRICES['claude-opus-5-5'];
  const u = msg.usage || {};
  return ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25) * pr[0] / 1e6
    + (u.output_tokens || 0) * pr[1] / 1e6
    + (u.cache_read_input_tokens || 0) * pr[2] / 1e6
    + (u.server_tool_use?.web_search_requests || 0) * SEARCH_USD;
}

const NUM = (d) => ({ type: 'number', description: d });

const SAVE_TOOL = {
  name: 'zapisz_produkty',
  description: 'Saves the recognised foods with nutrition values per 100 g. Call it exactly once, after the research is done.',
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
          required: ['name', 'grams', 'piece_grams', 'kcal', 'protein', 'fat', 'saturated_fat', 'fibre', 'salt', 'category', 'veg_fruit_g', 'source_name', 'source_url', 'note'],
          properties: {
            name: { type: 'string', description: 'Polish name of the food or dish including its form, e.g. "Makaron pełnoziarnisty (ugotowany)" or "Zapiekana owsianka z bananem i borówkami". For a dish this is the dish name, never a list of amounts.' },
            grams: NUM('Amount eaten, in grams (for a dish, the weight of the portion eaten)'),
            piece_grams: NUM('Weight of one piece in grams if the food is counted in pieces (egg, fruit, slice), else 0'),
            kcal: NUM('kcal per 100 g'),
            protein: NUM('Protein, g per 100 g'),
            fat: NUM('Total fat, g per 100 g'),
            saturated_fat: NUM('Saturated fat, g per 100 g'),
            fibre: NUM('Dietary fibre, g per 100 g'),
            salt: NUM('Salt, g per 100 g (if only sodium is given: sodium × 2.5)'),
            category: {
              type: 'string',
              enum: ['fish', 'legumes', 'red_meat', 'none'],
              description: 'fish: fish and seafood; legumes: lentils, beans, chickpeas, peas, soy, tofu; red_meat: beef, pork, lamb and any cold cuts or sausages (wędliny); none: everything else',
            },
            veg_fruit_g: NUM('Grams of vegetables and fruit in 100 g of this food: 100 for a plain vegetable or fruit, 0 for none, in between for a dish (fruit and vegetables count; potatoes, legumes, juice and dried fruit do not)'),
            source_name: { type: 'string', description: 'Where the numbers come from, e.g. "Open Food Facts", "USDA FoodData Central", "szacunek"' },
            source_url: { type: 'string', description: 'URL of the page the numbers were taken from, or an empty string' },
            note: { type: 'string', description: 'Short Polish note: how the amount was converted to grams, assumptions, uncertainty. For a dish: the recipe used and the main ingredient amounts assumed. At most 250 characters. Empty string if none.' },
          },
        },
      },
    },
  },
};

const SYSTEM = `You convert a meal description into nutrition data for a personal food log. The user has high LDL cholesterol, so saturated fat must be accurate.

First decide what the description contains. It is either a list of separate foods ("2 jajka, banan, 150 g skyru") or a dish: a prepared meal whose ingredients follow its name, after "z"/"ze" or in a list ("zapiekana owsianka z bananem, skyrem, borówkami"). The ingredients of a dish are NOT extra portions. Return one item for the whole dish, never one item per ingredient plus one for the dish. When a dish is followed by something with its own amount and clearly separate ("owsianka z bananem, 2 jajka"), that is another item.

For each separate food:
1. Work out the amount eaten in grams. Convert pieces, spoons, slices and packages to grams and say how in "note" (e.g. "2 szt. × 60 g").
2. Get values per 100 g for the form the user ate (raw, dry or cooked; if they do not say, assume the form the amount most plausibly refers to and say so in "note").
   - Look the values up with web search instead of relying on memory. Prefer, in this order: the manufacturer's label or a shop listing for a named brand; Open Food Facts for a named brand; USDA FoodData Central or Polish IŻŻ tables for generic foods. Put the page the numbers came from in source_url.
3. If no source gives a value (often saturated fat or fibre), estimate it, set source_name "szacunek" if the whole item is estimated, and name the estimated values in "note".

For a dish:
1. If the user gave a weight for it ("195g: …"), that is the amount eaten.
2. Search the web for a recipe of that dish (a recipe page or a food database entry), take its ingredient list and quantities, and where the user named the ingredients use those. Look up each ingredient's nutrition per 100 g the same way as for a separate food. These lookups are internal: do not return the ingredients as items.
3. Compute the values per 100 g of the finished dish: sum the ingredients, divide by the finished weight, and apply cooking or baking losses only when the recipe states them. The user will save the result and reuse it, so it must be per 100 g of the dish as eaten.
4. veg_fruit_g is the share of vegetables and fruit in the dish. Decide for each ingredient yourself whether it is a vegetable or fruit.
5. source_url is the recipe page; note lists the main ingredient amounts you assumed, in at most 250 characters. If you found no recipe, assume a typical one, say so in note and set source_name "szacunek".

When done, call zapisz_produkty once with all items. Write names and notes in Polish. Do not write any other answer.`;

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

// Returns { items, cost } where cost is the estimated USD price of the request.
// Products already in the local library are matched before this is called, so only unknown foods arrive here.
export async function analyze({ apiKey, model, text, signal }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const messages = [{ role: 'user', content: `What I ate:\n${text}` }];
  let cost = 0;
  // A long web-search turn can stop with pause_turn; resend it to let Claude continue.
  for (let turn = 0; turn < 4; turn++) {
    const msg = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: [
        {
          type: 'web_search_20260209',
          name: 'web_search',
          max_uses: 10,
          user_location: { type: 'approximate', country: 'PL', timezone: 'Europe/Warsaw' },
        },
        SAVE_TOOL,
      ],
      tool_choice: { type: 'auto' },
      messages,
    }, { signal });
    cost += costOf(msg);
    if (msg.stop_reason === 'refusal') throw new Error('Model odmówił odpowiedzi. Opisz posiłek inaczej.');
    const call = msg.content.find((b) => b.type === 'tool_use' && b.name === SAVE_TOOL.name);
    if (call) return { items: call.input.items, cost };
    if (msg.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: msg.content });
  }
  throw new Error('Model nie zwrócił wyniku. Spróbuj opisać posiłek dokładniej.');
}
