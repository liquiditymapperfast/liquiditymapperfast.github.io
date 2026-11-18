import { el } from './dom.ts';
import { t, tn } from './i18n.ts';
import { clock } from './format.ts';
import { button, heading, note } from './ui.ts';
import { readLayouts, LAYOUTS_KEY } from './layouts/layouts.ts';
import { readScripts, SCRIPTS_KEY } from './script/records.ts';
import { readDoc } from './draw/model.ts';
import { DRAW_KEY } from './draw/storage.ts';
import { CUSTOM_THEMES_KEY, readCustomThemes } from './custom-themes.ts';
import { MAX_BACKUP_CHARS, backupFile, collectItems, queueRestore, readBackup } from './backup.ts';

/**
 * The Back up and restore panel (from the Layouts panel, and a phone's or tablet's Settings): one file with everything the page keeps in this
 * browser, and that file read back in place of it. A restore is confirmed in the panel, saying what the file holds and that it replaces what
 * is here, then the page reloads with it (backup.ts).
 */

/** A restore read from a file and waiting for the person's yes; what the panel last said. Kept across redraws while it is open. */
export interface BackupState { pending: { text: string; items: Record<string, string>; savedAt: number } | null; message: { text: string; error: boolean } | null }
export const newBackupState = (): BackupState => ({ pending: null, message: null });

const parse = (raw: string | undefined): unknown => { try { return raw === undefined ? null : JSON.parse(raw); } catch { return null; } };

/** What a set of items holds, as a person counts it: "3 layouts, 2 scripts, 12 drawings, 1 theme, the settings". */
export function describeItems(items: Readonly<Record<string, string>>): string {
  const layouts = readLayouts(parse(items[LAYOUTS_KEY])).length, scripts = readScripts(parse(items[SCRIPTS_KEY])).length, themes = readCustomThemes(parse(items[CUSTOM_THEMES_KEY])).length;
  const doc = items[DRAW_KEY] === undefined ? null : readDoc(parse(items[DRAW_KEY]));
  const drawings = doc ? Object.values(doc.coins).reduce((n, list) => n + list.length, 0) : 0;
  const parts = [
    ...(layouts ? [tn(layouts, '{n} layout', '{n} layouts')] : []), ...(scripts ? [tn(scripts, '{n} script', '{n} scripts')] : []),
    ...(drawings ? [tn(drawings, '{n} drawing', '{n} drawings')] : []), ...(themes ? [tn(themes, '{n} theme', '{n} themes')] : []),
    ...(items['hlm-app-v2'] !== undefined ? [t('the settings')] : []),
  ];
  return parts.length ? parts.join(', ') : t('nothing but small choices');
}

export function buildBackup(body: HTMLElement, redraw: () => void, ui: BackupState): void {
  const say = (text: string, error = false): void => { ui.message = { text, error }; redraw(); };
  body.append(note(t('One file with everything this page keeps in this browser: the settings, your layouts, scripts, drawings and themes, the coin and the venues. Keep it, or open it in another browser or on another computer. The recorded market history is not in it.')));
  if (ui.message) body.append(el('p', { class: ui.message.error ? 'panel-note layout-message error' : 'panel-note layout-message', textContent: ui.message.text }));

  if (ui.pending) {
    const p = ui.pending;
    body.append(heading(t('Restore this backup?')),
      note(p.savedAt ? t('Saved on {time}. It holds {what}.', { time: clock(p.savedAt, true), what: describeItems(p.items) }) : t('It holds {what}.', { what: describeItems(p.items) })),
      note(t('Restoring replaces what this browser keeps for the page (settings, layouts, scripts, drawings and themes), then reloads the page. Save a backup first if you may want what is here now.')),
      note(t('Other tabs of the page reload too: a script being written there and not yet saved is lost.')),
      el('div', { class: 'layout-tools' },
        button(t('Restore'), () => {
          // Left for the reload, so nothing of this page can write over it. A tab that will not hold it restores nothing: written while this page
          // runs, the page could write its own settings back over part of it.
          let queued = false;
          try { queued = queueRestore(window.sessionStorage, p.text); } catch { queued = false; }
          if (!queued) { ui.pending = null; say(t('This browser did not let the page keep it.'), true); return; }
          window.location.reload();
        }, t('Replace what is here with the backup and reload the page')),
        button(t('Cancel'), () => { ui.pending = null; ui.message = null; redraw(); })));
    return;
  }

  const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  file.onchange = () => {
    const chosen = file.files?.[0]; if (!chosen) return;
    // A file far larger than a backup is something else: not read at all (a character is at most four bytes).
    if (chosen.size > MAX_BACKUP_CHARS * 4) { say(t('This is not a backup file.'), true); return; }
    void chosen.text().then(text => {
      const read = readBackup(text);
      if ('items' in read) { ui.pending = { text, items: read.items, savedAt: read.savedAt }; ui.message = null; redraw(); return; }
      if (read.error === 'other') say(read.kind === 'layouts' ? t('This is a layouts file: read it with Import in the Layouts panel.') : read.kind === 'themes' ? t('This is a themes file: read it with Import in the theme menu’s last row.') : t('This is a scripts file: read it with Import in the Scripts panel.'), true);
      else say(read.error === 'newer' ? t('This backup is from a newer version of the page: reload the page and try again.') : read.error === 'empty' ? t('The file holds nothing this page can read.') : t('This is not a backup file.'), true);
    }, () => say(t('This is not a backup file.'), true));
  };
  const save = (): void => {
    let items: Record<string, string>;
    try { items = collectItems(window.localStorage); } catch { say(t('This browser did not let the page keep it.'), true); return; }
    const now = Date.now();
    const url = URL.createObjectURL(new Blob([backupFile(items, now)], { type: 'application/json' }));
    el('a', { href: url, download: `liquiditymapperfast-backup-${new Date(now).toISOString().slice(0, 10)}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    say(t('Saved a backup with {what}.', { what: describeItems(items) }));
  };
  body.append(el('div', { class: 'layout-tools' },
    button(t('Save a backup'), save, t('Write everything the page keeps in this browser to one file')),
    button(t('Restore a backup…'), () => file.click(), t('Read a backup file; you are asked before anything is replaced')), file));
}
