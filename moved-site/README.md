# The old address's page

What `https://liquiditymapperfast.github.io/` serves since the site moved to `https://liquiditymapper.com/` (2026-11-14). It is not part
of the page's build: `.github/workflows/pages.yml` publishes this folder as it is to GitHub Pages from this same repository
(`liquiditymapperfast/liquiditymapperfast.github.io`, an organization's after the move), while the built page goes to Cloudflare. The
repository stays here because GitHub retires the name of a popular repository that is transferred (over 100 clones a week; 2,975 in the
14 days to 2026-11-14), which would end this address for good; it can move once the old address no longer matters.

- `index.html` and `404.html` (the same file) send every visit on: the root to the new root with what the browser saved on the old
  address in the fragment (taken once by `src/app/handover.ts`), any other path to the same path there. An installed copy of the app gets
  a note to install it again from the new address instead of being sent off.
- `assets/moved-v1a2026.js` does nothing: its name, read as a build's by `src/app/update-check.ts`, makes a tab still open on the old
  site offer Reload, which brings it here.
- `.nojekyll` publishes the files as they are (needed only if the folder were ever published from a branch).

`tests/app-handover.test.mts` runs this page's script against the receiver, so a change to the key rule or the encoding on either side
fails there. Keep the redirect for as long as old links matter; remove `src/app/handover.ts` only after the old address stops handing
over (and never let the `liquiditymapperfast` name lapse: whoever took it could serve a page there).
