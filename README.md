# Food tracker

Dzienny dziennik jedzenia na bazie jadłospisu A/B z lekcji `teach/zdrowie`. Cele dzienne: 2250–2550 kcal, białko ≥ 110 g, nasycone < 19 g (7% energii), błonnik ≥ 25 g, warzywa i owoce ≥ 400 g, sól < 5 g. Tygodniowe: ryba 2×, strączkowe 2×, czerwone mięso i wędliny ≤ 500 g.

- Dzień to zwykła lista „Zjedzone”. Jadłospis A/B jest w zwijanej sekcji „Inspiracja”: „+ Dodaj” przy posiłku dopisuje jego produkty do dnia. Dni zapisane jeszcze w trybie A/B zamieniają się w listę przy pierwszym otwarciu.
- Na dole trzy sposoby dodawania:
  - **Ręcznie**: wartości z etykiety (bez API). „Ostatnio jedzone” wypełnia formularz czymś z ostatnich dwóch tygodni.
  - **Opisz**: opis po polsku i opcjonalnie waga porcji. Claude podaje wartości na 100 g z tabel USDA / IŻŻ, a w sieci szuka tylko produktów markowych i nieznanych dań (najwyżej 2 wyszukania). Danie z listą składników („owsianka z bananem, skyrem”) to jedna pozycja.
  - **Zdjęcie**: zdjęcie posiłku, opcjonalnie opis i waga. Zdjęcie jest zmniejszane do 1024 px przed wysłaniem.
- Ołówek przy pozycji z AI → „Porównaj z innym modelem”: to samo zapytanie idzie do wybranego modelu, obie odpowiedzi stoją obok siebie, „Użyj nowych wartości” podmienia pozycję. Przy zdjęciu działa tylko w tej samej sesji (zdjęcie nie jest zapisywane).
- Wynik pojawia się od razu jako wiersz ze znaczkiem ładowania i zastępuje go w miejscu. „Cofnij” usuwa wynik, ołówek otwiera edycję.
- Koszty: ⋯ → „Wydane w tym miesiącu” pokazuje 50 ostatnich zapytań z tokenami wejścia/wyjścia, liczbą wyszukań i kosztem. `test.html` (link pod listą) porównuje modele na tych samych przykładach.
- Waga i talia: jedna linijka na dzień, pod podsumowaniem. Pokazuje średnią wagi z 7 dni i zmianę względem poprzedniego tygodnia oraz zmianę talii.
- Dane: najpierw `localStorage` (jeden wpis na dzień, `ft:day:RRRR-MM-DD`), a kopia i synchronizacja telefon ↔ komputer w osobnym **prywatnym** repo (patrz niżej). Eksport i import JSON w ustawieniach to dodatkowa kopia.

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

## Kopia danych i synchronizacja

Repo z danymi (domyślnie `grabowskirobert/food-tracker-data`, prywatne) zawiera `days/RRRR-MM.json` (dni z posiłkami, wagą i talią) (starszy `foods.json` z „moimi produktami” nie jest już używany). Tego repo nie wolno robić publicznym.

1. Utwórz prywatne repo z README (puste repo też zadziała, pierwszy zapis tworzy pierwszy commit).
2. GitHub → Settings → Developer settings → Fine-grained tokens: dostęp tylko do tego repo, uprawnienie *Contents: Read and write*, data ważności do roku.
3. W aplikacji: ⋯ → Token GitHub → Zapisz. Kropka przy ⋯: zielona = zsynchronizowane, szara = czeka lub trwa, czerwona = brak udanej synchronizacji od ponad doby.

Kiedy: przy otwarciu i powrocie do aplikacji, 30 s po ostatniej zmianie, przy wyjściu z aplikacji (iOS nie gwarantuje, że zdąży), po odzyskaniu internetu i ręcznie w ustawieniach. W tle aplikacja nie synchronizuje, bo iOS nie pozwala stronie działać po zamknięciu.

Scalanie: każdy dzień i produkt ma znacznik czasu `upd`, wygrywa nowsza wersja całego dnia. Konflikt zapisu (drugie urządzenie wysłało w międzyczasie) kończy się pobraniem, scaleniem i drugą próbą. Usunięty produkt zostaje w pliku jako znacznik `del`, żeby usunięcie dotarło na drugie urządzenie. Gdy token wygaśnie, aplikacja działa dalej lokalnie, a po wklejeniu nowego tokenu wysyła zaległości.

## Pliki

| Plik | Co robi |
|---|---|
| `index.html`, `style.css`, `app.js` | interfejs, zapis dnia, sumy i cele |
| `data.js` | produkty, jadłospis A/B i cele z lekcji |
| `llm.js` | zapytanie do Claude (opis lub zdjęcie), koszt zapytania |
| `test.html`, `test.js` | porównanie modeli na przykładach |
| `sync.js` | kopia i synchronizacja z prywatnym repo przez API GitHuba |
| `boot.js` | gdy skrypty aplikacji nie wystartują, czyści pamięć podręczną i przeładowuje stronę raz |
| `sw.js`, `manifest.webmanifest`, `icons/` | instalacja na ekranie głównym, działanie offline |
| `vendor/anthropic-sdk-*.mjs` | SDK zbudowane do jednego pliku (`scripts/build-sdk.sh <wersja>`) |

Lokalnie: `python3 -m http.server` i `http://localhost:8000`.

## Wdrożenia

`sw.js` zapisuje całą aplikację w pamięci podręcznej jednej wersji (`CACHE`) i przy każdym uruchomieniu najpierw pyta sieć z pominięciem pamięci HTTP przeglądarki (GitHub Pages ustawia `max-age=600`, więc pliki pobrane w różnych momentach mogłyby pochodzić z różnych wdrożeń). Gdy sieć zawiedzie, odpowiada ta zapisana wersja. **Po zmianie któregokolwiek pliku z listy `SHELL` w `sw.js` zwiększ numer `CACHE`.**
