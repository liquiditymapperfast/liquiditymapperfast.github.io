# Languages

The page speaks English, Spanish, German, French, Portuguese, Italian, Russian, Ukrainian, Turkish, Chinese, Japanese and Korean. It starts in the first of your browser's preferred languages that it has a pack for (any Chinese tag, `zh-TW` included, gets the one Chinese pack), and falls back to English. A **Language** button (beside the theme button on the full toolbar, and under Appearance in Settings) chooses one or goes back to **Automatic**; `?lang=de` in the address overrides both. Choosing reloads the page, because the words are picked as the page is built.

## Why not leave it to the browser

A browser's own translation works on request, on the text in the page. It does not reach what this page draws on its canvases (pane titles, the labels on the map, the order-book headers, every popup beside the pointer) or the tooltips (they are attributes, not text), and a general translator renders finance words ("bid", "ask", "footprint", "delta") as ordinary words that no trader would use. A built-in pack covers all of it, uses the words traders use, and needs no click.

## How it is built

- **English is the key.** `t('Guide')` is "Guide" until the loaded pack has another word for it; a text a pack lacks stays English, so a half-finished pack leaves no hole. Text with a value in it names the place in braces: `t('{shown} of {total} shown', { shown, total })`. A count that changes the wording goes through `tn(n, '{n} note', '{n} notes')`, and a pack gives each form its language needs (Russian has `one`, `few`, `many`, `other`).
- `src/app/i18n.ts` is plain code with nothing to load, so tests import it. `src/app/i18n-load.ts` picks the language and fetches its pack (`src/app/i18n/<code>.json`, each its own file, about 19 kB gzipped); `src/app/boot.ts`, the page's first script, waits for it before it loads the rest. That is why a module may call `t()` at the top level.
- Dates follow the language (`Intl.DateTimeFormat`). Numbers do not: `K`, `M`, `B` and the point as the decimal mark stay, so a price reads the same everywhere.

## What is not translated

A server's status words that code reads (`stateOfStatus`), venue names, the names of the sound tiers, the keyboard keys in the guide's key caps (only the mouse wheel is named in the language), and the abbreviations OI, LT, CVD and the like.

## The guide

The guide is translated too, apart from the page's words so that a page that never opens it never downloads them: `src/app/guide/i18n/<code>.json` maps each English text of the guide (sections, captions, key rows, and every word its pictures draw through `tg('...')` in `figures.ts`) to the language's text, and `guide.ts` fetches the one for the page's language when the guide opens (English is the text in the source). `npm run i18n:guide -- ko > src/app/guide/i18n/ko.json` writes the template. A guide text keeps its inline markup (`**bold**`, `*italic*`, `` `code` ``, `[[Key]]`), and `tests/app-guide-i18n.test.mts` fails on a missing or extra text, a lost mark or placeholder, a translated key cap other than the wheel, or a pack that is mostly English. Names of buttons and panes in a guide text use the page's own word for them (the page's pack says what the Mirror button is called in that language).

## Adding a language

1. `npm run i18n:template -- ko > src/app/i18n/ko.json` writes every text, in English, with the plural forms that language needs; `npm run i18n:guide -- ko > src/app/guide/i18n/ko.json` does the same for the guide.
2. Translate the values. Keep every `{placeholder}` exactly; use no `<`, `>` or HTML entities (some texts are set as HTML); keep a word short where it sits in a tight place: the dock tabs, the toggles in Settings, and the book's `DEPTH + CUM` header (about 13 characters at most).
3. Add `{ code: 'ko', name: '한국어' }` to `LANGUAGES` in `src/app/i18n.ts` (the name is the language in itself).
4. `npm test`. `tests/app-i18n-packs.test.mts` fails until the pack has every text and no text the page no longer asks for, every placeholder, no markup and the plural forms.
5. Open the page with `?lang=ko` at a desktop size and at 360 px wide and look for text that is wider than its box. Chrome over CDP can list those: compare `scrollWidth` with `clientWidth` on the toolbar, the sheets and the panels, then look at the canvases by eye.

A new sentence on the page is written `t('...')` from the start; the same test fails on any text a person reads that is not.

## Where the translations come from

The eleven packs were written by an AI assistant, not by native speakers, and have not been reviewed by any. Terms follow what traders use in each language (for example 订单簿 for the order book in Chinese, `стакан` in Russian, `Orderbuch` in German; Bid, Ask, Footprint, Delta and CVD stay as they are in the Latin-script languages). A correction is an edit to one JSON value.
