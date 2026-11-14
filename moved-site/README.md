# The old address's page

What `https://liquiditymapperfast.github.io/` serves once the site has moved to `https://liquiditymapper.com/`. It is not part of the
page's build: these files are the whole of a repository named `liquiditymapperfast.github.io` under the `liquiditymapperfast` account
(an organization owned by the main account after the move), published by GitHub Pages from its default branch, root folder.

- `index.html` and `404.html` (the same file) send every visit on: the root to the new root with what the browser saved on the old
  address in the fragment (taken once by `src/app/handover.ts`), any other path to the same path there. An installed copy of the app gets
  a note to install it again from the new address instead of being sent off.
- `assets/moved-v1a2026.js` does nothing: its name, read as a build's by `src/app/update-check.ts`, makes a tab still open on the old
  site offer Reload, which brings it here.
- `.nojekyll` publishes the files as they are.

`tests/app-handover.test.mts` runs this page's script against the receiver, so a change to the key rule or the encoding on either side
fails there. Keep the redirect for as long as old links matter; remove `src/app/handover.ts` only after the old address stops handing
over (and never let the `liquiditymapperfast` name lapse: whoever took it could serve a page there).
