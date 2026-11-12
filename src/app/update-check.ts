/**
 * Whether the site serves a newer build than this tab runs. A tab keeps the build it was opened with for as long as it lives: the page
 * never reloads itself (lazy.ts: a reload loses what the tab holds only in memory) and fetches its parts soon after it starts, so a deploy
 * cannot take them away. On 2026-11-08 a tab fifteen hours old still drew pictures without the fixes the site had had since the night
 * before, and nothing said so. So the page asks now and then which build the site serves, and when it is another one it says so
 * (update-notice.ts). Only the person reloads.
 *
 * A build is named by its first script, `assets/index-<hash>.js`: each file's name carries a hash of what it holds and of the names of the
 * files it loads, so the name changes with any change to the code or the styles (a one-value change to `styles.css` renamed it, measured
 * 2026-11-12), and the same build gives the same name. A page that is not a build (the development server's `/boot.ts`) has no name and
 * asks nothing.
 */

/** How often a tab that is shown asks (ms). */
export const CHECK_EVERY_MS = 15 * 60_000;
/** The first question, after the start: a page opened from the browser's cache (GitHub Pages lets it keep the page ten minutes) can be stale from the start. */
export const FIRST_CHECK_MS = 2 * 60_000;
/** A tab shown again asks at once when its last question is at least this old (ms). */
export const SHOWN_AGAIN_MS = 5 * 60_000;
/**
 * How long a notice put away stays away (ms): a day, whatever is deployed meanwhile. The site is deployed several times on some days, and a
 * notice for each deploy would nag about a choice already made; a tab still behind a day later is told again.
 */
export const QUIET_MS = 24 * 3_600_000;
/** How long one question may take (ms). */
export const CHECK_TIMEOUT_MS = 20_000;

/** The name of a build from the address of its first script (`./assets/index-NYsfP7Ku.js` gives `index-NYsfP7Ku.js`); null for a script that is not a build's. */
export function buildOf(src: string | null | undefined): string | null {
  if (!src) return null;
  const m = /(?:^|\/)assets\/([\w-]+-[\w-]{6,}\.js)(?:[?#].*)?$/.exec(src.trim());
  return m ? m[1]! : null;
}

/** The build a page's HTML starts: the first module script it names that is a build's (attributes in any order, any quotes), or null. */
export function buildIn(html: string): string | null {
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\stype\s*=\s*(["']?)module\1(?=[\s/>])/i.test(tag[0])) continue;
    const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag[0]);
    const name = buildOf(src ? src[1] ?? src[2] ?? src[3] : null);
    if (name) return name;
  }
  return null;
}

/** What an answer means for the notice: a newer build to offer, the tab's own build again (an offer is taken back), or nothing known. */
export type BuildAnswer = 'offer' | 'withdraw' | 'none';

/** What the site's answer `deployed` means for a tab running `own`: no answer, or one that names no build, changes nothing. */
export function answerFor(own: string | null, deployed: string | null): BuildAnswer {
  if (!own || !deployed) return 'none';
  return deployed === own ? 'withdraw' : 'offer';
}

/** Whether a notice may be shown at `now`: not within a day of the person's putting one away at `dismissedAt` (0: never). */
export const mayOffer = (dismissedAt: number, now: number): boolean => !(dismissedAt > 0 && now - dismissedAt < QUIET_MS);

/** Whether a tab shown again asks at once, its last question asked at `lastAsked`. */
export const dueWhenShown = (lastAsked: number, now: number): boolean => now - lastAsked >= SHOWN_AGAIN_MS;

/** The build this page runs: its first module script that is a build's. */
export function ownBuild(doc: Document = document): string | null {
  for (const script of doc.querySelectorAll('script[type="module"][src]')) {
    const name = buildOf(script.getAttribute('src'));
    if (name) return name;
  }
  return null;
}

export interface BuildWatch {
  /** The build this tab runs (null: not a build, and nothing is asked). */
  readonly own: string | null;
  /** Ask now (also the page's debugging object, `__hlm.update.check()`): the name the site gave, or null for no answer. */
  check(): Promise<string | null>;
}

/**
 * Ask the site which build it serves, the page itself (`./`) past the browser's cache (`no-cache`: an unchanged page is a short "not
 * modified"): a couple of minutes after the start, then every quarter of an hour while the tab is shown, and when it is shown again after
 * five minutes or more. A hidden tab asks nothing (a notice it cannot show is no use). One question at a time; one that fails changes nothing.
 * `answer` gets what each answer means (`answerFor`) and the name the site gave.
 */
export function watchBuild(answer: (meaning: BuildAnswer, deployed: string | null) => void, doc: Document = document): BuildWatch {
  const own = ownBuild(doc);
  let asking: Promise<string | null> | null = null, lastAsked = Date.now();
  const ask = async (): Promise<string | null> => {
    try {
      const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(CHECK_TIMEOUT_MS) : undefined;
      const res = await fetch(new URL('./', location.href), { cache: 'no-cache', ...(signal ? { signal } : {}) });
      return res.ok ? buildIn(await res.text()) : null;
    } catch { return null; }
  };
  const check = (): Promise<string | null> => {
    if (!own) return Promise.resolve(null);
    if (asking) return asking;
    lastAsked = Date.now();
    asking = ask().then(deployed => { asking = null; answer(answerFor(own, deployed), deployed); return deployed; });
    return asking;
  };
  if (own) {
    const shown = (): boolean => doc.visibilityState !== 'hidden';
    setTimeout(() => { if (shown()) void check(); }, FIRST_CHECK_MS);
    setInterval(() => { if (shown()) void check(); }, CHECK_EVERY_MS);
    doc.addEventListener('visibilitychange', () => { if (shown() && dueWhenShown(lastAsked, Date.now())) void check(); });
  }
  return { own, check };
}
