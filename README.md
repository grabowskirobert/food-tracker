# Food tracker

Dzienny dziennik jedzenia na bazie jadłospisu A/B z lekcji `teach/zdrowie`. Cele dzienne: 2250–2550 kcal, białko ≥ 110 g, nasycone < 19 g (7% energii), błonnik ≥ 25 g, warzywa i owoce ≥ 400 g, sól < 5 g. Tygodniowe: ryba 2×, strączkowe 2×, czerwone mięso i wędliny ≤ 500 g.

- Dzień A, Dzień B albo Własny: gramy w planie edytowalne, każdy posiłek można pominąć.
- „Co zjadłeś?”: opis po polsku → Claude szuka wartości na 100 g w sieci (etykieta producenta, Open Food Facts, USDA FoodData Central, tabele IŻŻ), przelicza porcje, podaje źródło. Przed dodaniem sprawdzasz i poprawiasz gramy.
- Produkty raz sprawdzone trafiają do „moich produktów” i przy kolejnym opisie model bierze je stamtąd zamiast szukać.
- „+”: dodanie ręczne z etykiety albo z listy moich produktów (bez API).
- Dane: `localStorage` w przeglądarce, jeden wpis na dzień (`ft:day:RRRR-MM-DD`). Eksport i import JSON w ustawieniach.

Bez backendu i bez kroku budowania: statyczne pliki, hostowane na GitHub Pages.

## Uruchomienie

1. GitHub → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
2. Na iPhonie otwórz adres strony w Safari → Udostępnij → *Do ekranu początkowego*.
3. W [konsoli Anthropic](https://console.anthropic.com): utwórz osobny workspace, ustaw w nim miesięczny limit wydatków i włącz wyszukiwanie w sieci (Settings → Privacy / web search). Wygeneruj klucz API w tym workspace.
4. W aplikacji: ⋯ → wklej klucz → Zapisz.

## Klucz API

Klucz jest zapisany tylko w `localStorage` tej aplikacji na telefonie. Nie ma go w repo ani na stronie, więc inne osoby otwierające stronę go nie dostają. Zabezpieczenia:

- Content-Security-Policy w `index.html`: skrypty tylko z tej domeny, połączenia tylko do `api.anthropic.com`.
- SDK Anthropic jest wbudowane w repo (`vendor/`), strona nie ładuje skryptów z zewnątrz.
- Tekst z sieci i od modelu jest wstawiany jako tekst, nigdy jako HTML.
- Limit wydatków workspace ogranicza maksymalną stratę, a klucz można w każdej chwili unieważnić w konsoli.

## Pliki

| Plik | Co robi |
|---|---|
| `index.html`, `style.css`, `app.js` | interfejs, zapis dnia, sumy i cele |
| `data.js` | produkty, jadłospis A/B i cele z lekcji |
| `llm.js` | zapytanie do Claude z wyszukiwaniem w sieci |
| `sw.js`, `manifest.webmanifest`, `icons/` | instalacja na ekranie głównym, działanie offline |
| `vendor/anthropic-sdk-*.mjs` | SDK zbudowane do jednego pliku (`scripts/build-sdk.sh <wersja>`) |

Lokalnie: `python3 -m http.server` i `http://localhost:8000`.
