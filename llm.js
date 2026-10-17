// Turns a free-text meal description into food items with values per 100 g.
// Claude looks the values up with web search; the result comes back through the
// zapisz_produkty tool so it is always schema-valid JSON.
import Anthropic from './vendor/anthropic-sdk-0.131.0.mjs';

export const MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 (dokładniejszy)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (tańszy)'],
];

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
          required: ['name', 'grams', 'kcal', 'protein', 'fat', 'saturated_fat', 'fibre', 'veg_fruit', 'source_name', 'source_url', 'note'],
          properties: {
            name: { type: 'string', description: 'Polish product name including its form, e.g. "Makaron pełnoziarnisty (ugotowany)"' },
            grams: NUM('Amount eaten, in grams'),
            kcal: NUM('kcal per 100 g'),
            protein: NUM('Protein, g per 100 g'),
            fat: NUM('Total fat, g per 100 g'),
            saturated_fat: NUM('Saturated fat, g per 100 g'),
            fibre: NUM('Dietary fibre, g per 100 g'),
            veg_fruit: { type: 'boolean', description: 'True for vegetables and fruit (not potatoes, not juice)' },
            source_name: { type: 'string', description: 'Where the numbers come from, e.g. "Open Food Facts", "USDA FoodData Central", "moje produkty", "szacunek"' },
            source_url: { type: 'string', description: 'URL of the page the numbers were taken from, or an empty string' },
            note: { type: 'string', description: 'Short Polish note: how the amount was converted to grams, assumptions, uncertainty. Empty string if none.' },
          },
        },
      },
    },
  },
};

const SYSTEM = `You convert a meal description into nutrition data for a personal food log. The user has high LDL cholesterol, so saturated fat must be accurate.

For each food in the description:
1. Work out the amount eaten in grams. Convert pieces, spoons, slices and packages to grams and say how in "note" (e.g. "2 szt. × 60 g").
2. Get values per 100 g for the form the user ate (raw, dry or cooked; if they do not say, assume the form the amount most plausibly refers to and say so in "note").
   - If the product is in the user's known products list, use those values, source_name "moje produkty", source_url "".
   - Otherwise look the values up with web search instead of relying on memory. Prefer, in this order: the manufacturer's label or a shop listing for a named brand; Open Food Facts for a named brand; USDA FoodData Central or Polish IŻŻ tables for generic foods. Put the page the numbers came from in source_url.
3. For a dish (restaurant meal, home recipe), split it into ingredients when the description allows it; otherwise use a comparable dish from a reliable source and say in "note" that it is an estimate.
4. If no source gives a value (often saturated fat or fibre), estimate it, set source_name "szacunek" if the whole item is estimated, and name the estimated values in "note".

When done, call zapisz_produkty once with all items. Write names and notes in Polish. Do not write any other answer.`;

function knownList(lib) {
  return Object.values(lib)
    .map((f) => `- ${f.n}: ${f.k} kcal, ${f.p} B, ${f.f} T, ${f.s} nas., ${f.b} bł.`)
    .join('\n');
}

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

export async function analyze({ apiKey, model, text, library, signal }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const messages = [{
    role: 'user',
    content: `Known products (per 100 g):\n${knownList(library)}\n\nWhat I ate:\n${text}`,
  }];
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
          max_uses: 6,
          user_location: { type: 'approximate', country: 'PL', timezone: 'Europe/Warsaw' },
        },
        SAVE_TOOL,
      ],
      tool_choice: { type: 'auto' },
      messages,
    }, { signal });
    if (msg.stop_reason === 'refusal') throw new Error('Model odmówił odpowiedzi. Opisz posiłek inaczej.');
    const call = msg.content.find((b) => b.type === 'tool_use' && b.name === SAVE_TOOL.name);
    if (call) return call.input.items;
    if (msg.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: msg.content });
  }
  throw new Error('Model nie zwrócił wyniku. Spróbuj opisać posiłek dokładniej.');
}
