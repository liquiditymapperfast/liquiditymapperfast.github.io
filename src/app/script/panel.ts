import { el } from '../dom.ts';
import { t, tn } from '../i18n.ts';
import { button, heading, note } from '../ui.ts';
import { toast } from '../toast.ts';
import { explain, questionButton } from '../help.ts';
import type { Analysis } from './lang/analysis.ts';
import type { ScriptError } from './lang/lexer.ts';
import type { ScriptResult, Warning } from './protocol.ts';
import { MAX_SCRIPTS, MAX_SOURCE_CHARS, ROW_DEFAULT, SCRIPT_API, cleanName, exportFile, importText, inferredOption, mergeScripts, newId, type OptionValue, type ScriptRecord } from './records.ts';
import { errorText, warningText } from './messages.ts';
import { exampleHeight, examples } from './examples.ts';
import { NEW_SCRIPT, sameOptions, statusOf, type ScriptsHost, type ScriptsPanelState } from './panel-state.ts';
import { aiBundle, type BundleInput } from './lang/reference.ts';
import { newestOf } from './protocol.ts';
import { aboutExample, aboutScript, exampleId, type ScriptAbout } from './about.ts';

export { panelClosed, type ScriptsHost, type ScriptsPanelState } from './panel-state.ts';

const isError = (a: Analysis | ScriptError): a is ScriptError => !('program' in a);

/** The file the page publishes the whole language in (public/script-reference.md), and the name a download of it is saved under. */
const REFERENCE_FILE = 'script-reference.md';

/**
 * The list's statuses written again where they stand, after a run: the list is not built again, so a menu, a switch or a Delete that waits
 * for its second press is not lost under the person's pointer.
 */
export function refreshStatuses(host: ScriptsHost, body: HTMLElement): void {
  for (const cell of body.querySelectorAll<HTMLElement>('[data-script-status]')) {
    const r = host.records.find(x => x.id === cell.dataset.scriptStatus); if (!r) continue;
    const st = statusOf(host, r);
    if (cell.textContent !== st.text) cell.textContent = st.text;
    cell.classList.toggle('error', st.error);
  }
}

/**
 * The "?" of a script of the page's own (`about.ts`) and, while it is open, its description in a box under the row, where the eye already is:
 * at the top of the panel, as a pane's "?" opens there, the examples' would open out of sight. `ui.about` holds the one open (`key`), so the
 * panel drawn again keeps it; opening another closes it.
 */
function aboutToggle(ui: ScriptsPanelState, redraw: () => void, key: string, about: ScriptAbout): { button: HTMLButtonElement; box: HTMLElement | null } {
  const open = ui.about === key, ask = questionButton(about.title);
  ask.classList.toggle('open', open);
  ask.setAttribute('aria-expanded', String(open));
  ask.dataset.focus = `about-${key}`;
  // Opened, its box is brought into view: on a phone a row low in the list would open it below the fold.
  ask.onclick = () => { ui.about = open ? null : key; redraw(); if (!open) document.querySelector('.panel .script-about')?.scrollIntoView({ block: 'nearest' }); };
  if (!open) return { button: ask, box: null };
  const box = el('div', { class: 'help-inline script-about' });
  explain(box, about);
  return { button: ask, box };
}

/** The options a script shows in its panel: those it declares, then those it reads without declaring them. */
function optionRows(a: Analysis | ScriptError, set: Readonly<Record<string, OptionValue>> = {}): { name: string; label: string; type: string; value: OptionValue; declared: boolean; min?: number; max?: number; step?: number }[] {
  if (isError(a)) return [];
  const rows = a.declared.map(d => ({ name: d.name, label: d.label ?? d.name, type: d.type, value: d.value, declared: true, ...(d.min !== undefined ? { min: d.min } : {}), ...(d.max !== undefined ? { max: d.max } : {}), ...(d.step !== undefined ? { step: d.step } : {}) }));
  for (const name of a.read) {
    // What it is: the value it already has says (a text stays a text), else its name, else it is a text.
    const had = Object.prototype.hasOwnProperty.call(set, name) ? set[name] : undefined, guess = had !== undefined ? had : inferredOption(name);
    const type = typeof guess === 'boolean' ? 'boolean' : typeof guess === 'number' ? 'number' : typeof guess === 'string' && /^(#|rgb|hsl)/i.test(guess) ? 'color' : 'text';
    rows.push({ name, label: name, type, value: guess ?? '', declared: false });
  }
  return rows;
}

/**
 * The Scripts panel: the list (switch each on or off, open it to write, delete it), and the editor (its name, its text, its options, and what
 * the last run said). Saving reads the text first and keeps it only once it reads; a run's error is shown with its line and column. A text that
 * is an indicator file or a workspace from another charting page is read as the scripts it holds.
 */
export function buildScriptsPanel(host: ScriptsHost, body: HTMLElement, redraw: () => void, ui: ScriptsPanelState): void {
  const say = (text: string, error = false): void => { ui.message = { text, error }; redraw(); };
  const keep = (list: ScriptRecord[], done: string): void => { if (host.setRecords(list)) say(done); else say(t('This browser did not let the page keep it.'), true); };
  if (ui.editing) { buildEditor(host, body, redraw, ui, keep, say); return; }

  body.append(note(t('Scripts draw your own indicators from the candles and the taker flow and liquidations of the exchanges on the page. Each runs on its own, apart from the page, and can read nothing else. Their language is the indicator-script language other charting pages use: JavaScript with plots and functions such as sma and ema.')));
  if (ui.message) body.append(el('p', { class: ui.message.error ? 'panel-note layout-message error' : 'panel-note layout-message', textContent: ui.message.text }));
  body.append(heading(t('Your scripts')));
  const list = host.records;
  if (!list.length) body.append(note(t('No scripts yet.')));
  for (const r of list) {
    const st = statusOf(host, r);
    const box = el('input', { type: 'checkbox', checked: r.on, ariaLabel: t('On') });
    box.onchange = () => {
      if (box.checked) host.showScripts();
      keep(list.map(x => x.id === r.id ? { ...x, on: box.checked } : x), box.checked ? t('“{name}” is on.', { name: r.name }) : t('“{name}” is off.', { name: r.name }));
    };
    const armed = ui.armed === r.id;
    const remove = button(armed ? t('Sure?') : t('Delete'), () => {
      if (!armed) { ui.armed = r.id; redraw(); return; }
      ui.armed = null; keep(list.filter(x => x.id !== r.id), t('Deleted “{name}”.', { name: r.name }));
    }, t('Delete this script (press twice)'));
    if (armed) remove.classList.add('armed');
    const up = button('↑', () => { const i = list.indexOf(r); if (i > 0) { const next = [...list]; [next[i - 1], next[i]] = [next[i]!, next[i - 1]!]; keep(next, t('Moved “{name}”.', { name: r.name })); } }, t('Move this script up (its row goes higher in the pane)'));
    up.disabled = list.indexOf(r) === 0;
    const status = el('span', { class: `layout-date${st.error ? ' error' : ''}`, textContent: st.text });
    status.dataset.scriptStatus = r.id;
    // One of the page's own scripts says what it is beside its name; a person's own has nothing to say there.
    const about = aboutScript(r), ask = about ? aboutToggle(ui, redraw, `list:${r.id}`, about) : null;
    const row = el('div', { class: 'layout-row script-row' },
      el('label', { class: 'script-on' }, box),
      button(r.name, () => { ui.editing = r.id; ui.draft = { name: r.name, source: r.source, options: { ...r.options }, place: r.place }; ui.message = null; redraw(); }, t('Open this script to change it')),
      ...(ask ? [ask.button] : []), status, up, remove);
    // Pointed at (or one of its buttons given the keyboard), the row shows its script on the map behind the panel (ScriptPane `preview`).
    row.dataset.preview = `rec:${r.id}`;
    body.append(row);
    if (ask?.box) body.append(ask.box);
  }

  // The examples, each a row with its own Add (no menu to pick from first) and its "?" (the name's tooltip is its first sentence), and a
  // script of one's own. A script added from an example carries the example's key in its id, so it keeps its description however it is changed.
  body.append(heading(t('Add')));
  const full = list.length >= MAX_SCRIPTS;
  for (const ex of examples()) {
    const place = ex.place ?? 'pane';
    const add = button(t('Add'), () => {
      host.showScripts();
      keep([...list, { id: exampleId(ex.key), name: ex.name, source: ex.source, options: {}, on: true, api: SCRIPT_API, height: exampleHeight(ex.source) ?? ROW_DEFAULT, place }], t('Added “{name}”.', { name: ex.name }));
    }, t('Add a ready-made script to start from'));
    add.disabled = full;
    const about = aboutExample(ex.key), ask = aboutToggle(ui, redraw, `add:${ex.key}`, about);
    const row = el('div', { class: 'layout-row script-example' }, el('span', { class: 'script-example-name', textContent: ex.name, tip: about.tip }), ask.button, el('span', { class: 'layout-date', textContent: place === 'map' ? t('On the map') : t('In its own row') }), add);
    row.dataset.preview = `ex:${ex.key}`;
    body.append(row);
    if (ask.box) body.append(ask.box);
  }
  const create = button(t('New script'), () => { ui.editing = NEW_SCRIPT; ui.draft = { name: '', source: '', options: {}, place: 'pane' }; ui.message = null; redraw(); }, t('Write a script, or paste one (an indicator file or a workspace works too)'));
  create.disabled = full;
  body.append(el('div', { class: 'layout-tools' }, create));
  if (full) body.append(note(t('At most {n} scripts: delete one first.', { n: MAX_SCRIPTS })));

  const file = el('input', { type: 'file', accept: '.json,.txt,.js,application/json,text/plain', hidden: true });
  file.onchange = () => {
    const chosen = file.files?.[0]; if (!chosen) return;
    void chosen.text().then(text => {
      const read = importText(text, cleanName(chosen.name.replace(/\.[a-z0-9]+$/i, '')) ?? t('Imported script'));
      if ('error' in read) { say(read.error === 'too-large' ? t('The file is too large to be scripts.') : read.error === 'newer' ? t('The file was written by a newer version of the page: update this page to read it.') : t('The file holds no script this page can read.'), true); return; }
      // An imported script is off until it is switched on: one from elsewhere should be read before it runs.
      const merged = mergeScripts(list, read.scripts.map(s => ({ ...s, on: false }))), n = merged.added + merged.replaced;
      const done = tn(n, 'Read {n} script: switch it on to run it.', 'Read {n} scripts: switch them on to run them.') + (merged.skipped ? ` ${t('{n} did not fit: at most {max}.', { n: merged.skipped, max: MAX_SCRIPTS })}` : '');
      if (n) keep(merged.list, done); else say(done, true);
    }, () => say(t('The file holds no script this page can read.'), true));
  };
  const exportAll = button(t('Export'), () => {
    const url = URL.createObjectURL(new Blob([exportFile(list)], { type: 'application/json' }));
    el('a', { href: url, download: 'liquiditymapperfast-scripts.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, t('Write the scripts to a file, to keep them or use them in another browser'));
  exportAll.disabled = !list.length;
  body.append(heading(t('More')), el('div', { class: 'layout-tools' }, button(t('Import'), () => file.click(), t('Read scripts from a file: one written by Export, an indicator file or a workspace from another charting page, or a script as text')), exportAll, file));
  body.append(heading(t('Language')), ...reference().map(line => note(line)));
  // The whole language, as the page publishes it for people and for AI assistants. It is a file: a click saves it, and the page says so (Karl,
  // 2026-11-01: a download that starts without a word is easily missed; the link used to open a blank tab that the browser turned into one).
  body.append(el('p', { class: 'panel-note' }, el('a', { href: `./${REFERENCE_FILE}`, download: REFERENCE_FILE, rel: 'noopener', textContent: t('The full language reference'), onclick: () => toast(t('The language reference is downloading as {name}. Look in your browser\'s downloads.', { name: REFERENCE_FILE })) })));
}

/** The short reference shown under the list. */
function reference(): string[] {
  return [
    t('Each candle runs the script once. A name set without var (x = ...) keeps its value from candle to candle and starts at 0; x[1] is its value one candle back. A var starts again each candle.'),
    t('Inputs: time (seconds), vbuy, vsell (dollars bought and sold at market), lbuy, lsell (dollars of shorts and longs liquidated), $price.open, .high, .low, .close (the chart\'s candle), renderer.length (candles so far), options.name.'),
    t('source(vbuy, type=spot, exchange=BINANCE, quote=USDT) reads over those markets only (the flow column\'s markets are the rest). Options: name = option(default=14, type=number|color|checkbox|text, label=...).'),
    t('Functions: sma, ema, rma, sum, cum, cma, highest, lowest, last, linreg, stoch, pivot_high, pivot_low, avg, avg_ohlc, heikinashi, ohlc, cum_ohlc, interpolate; Math and Number as in JavaScript.'),
    t('Plots: line, histogram, area, baseline, candlestick, plotbar, cloudarea, brokenarea, each with title=, color=, lineWidth=, priceScaleId=, scaleMargins=. A point can be an object: {time: time, value: x, color: c}.'),
    t('Not here: trade counts (cbuy, csell read NaN), single markets by name (EXCHANGE:pair), the chart library\'s series objects, try, switch. A candle that was not recorded reads NaN and draws nothing; the functions skip it.'),
  ];
}

function buildEditor(host: ScriptsHost, body: HTMLElement, redraw: () => void, ui: ScriptsPanelState, keep: (list: ScriptRecord[], done: string) => void, say: (text: string, error?: boolean) => void): void {
  const draft = ui.draft ??= { name: '', source: '', options: {}, place: 'pane' };
  const existing = host.records.find(r => r.id === ui.editing) ?? null;
  const name = el('input', { type: 'text', class: 'layout-name', maxLength: 40, placeholder: t('Name'), ariaLabel: t('Name'), value: draft.name });
  name.oninput = () => { draft.name = name.value; };
  const source = el('textarea', { class: 'script-source', spellcheck: false, rows: 16, ariaLabel: t('Script'), placeholder: t('line(cum(vbuy - vsell), title=CVD)'), value: draft.source });
  source.maxLength = MAX_SOURCE_CHARS;
  source.wrap = 'off';
  // In a window sized by its corners the text takes the room left (`.panel.sized`).
  source.dataset.fill = '';
  source.oninput = () => { draft.source = source.value; };
  // A tab key writes two spaces rather than leaving the box.
  source.onkeydown = e => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const s = source.selectionStart, end = source.selectionEnd;
    source.setRangeText('  ', s, end, 'end'); draft.source = source.value;
  };
  const place = el('select', { ariaLabel: t('Where') });
  place.append(new Option(t('In its own row'), 'pane'), new Option(t('On the map'), 'map'));
  place.value = draft.place;
  place.onchange = () => { draft.place = place.value === 'map' ? 'map' : 'pane'; };
  const where = el('label', { class: 'row script-option', tip: t('A row of its own in this pane, or on the map: the plots on the price scale (the default) at their prices, the others each on a scale of their own.') }, el('span', { textContent: t('Draw') }), place);
  body.append(el('div', { class: 'layout-save' }, name), where, source);
  const messageClass = (error: boolean): string => error ? 'panel-note layout-message error' : 'panel-note layout-message';
  let message = ui.message ? el('p', { class: messageClass(ui.message.error), textContent: ui.message.text }) : null;
  if (message) body.append(message);
  // Said in place (Copy for AI): the text keeps its selection and scroll, and the keyboard stays where it was. An editor rebuilt meanwhile
  // (by Check, Back or a run) has moved on: its message is not replaced and it is not rebuilt again.
  const tell = (text: string, error: boolean): void => {
    if (!source.isConnected) return;
    ui.message = { text, error };
    if (!message) { message = el('p'); source.after(message); }
    message.className = messageClass(error); message.textContent = text;
  };

  // What the last run said about the script as it is kept.
  if (existing) {
    const res = host.resultOf(existing.id);
    if (res && !res.ok) body.append(el('p', { class: 'panel-note layout-message error', textContent: errorText(res.error) }));
    const notes = [...host.warningsOf(existing.id), ...(res?.ok ? res.warnings : [])];
    for (const w of notes) body.append(note(warningText(w)));
  }

  // Its options, as the text reads now: the declared ones and those it reads without declaring.
  const probe: ScriptRecord = { id: existing?.id ?? NEW_SCRIPT, name: draft.name || 'x', source: draft.source, options: draft.options, on: true, api: SCRIPT_API, height: ROW_DEFAULT, place: draft.place };
  const rows = optionRows(host.analysisOf(probe), draft.options);
  if (rows.length) {
    body.append(heading(t('Options')));
    for (const o of rows) {
      const current = o.name in draft.options ? draft.options[o.name] : o.value;
      let input: HTMLInputElement;
      if (o.type === 'boolean') { input = el('input', { type: 'checkbox', checked: current === true || current === 1 }); input.onchange = () => { draft.options[o.name] = input.checked; }; }
      else if (o.type === 'number' || o.type === 'range') {
        input = el('input', { type: 'number', value: typeof current === 'number' ? String(current) : '', step: o.step !== undefined ? String(o.step) : 'any' });
        input.oninput = () => { const v = Number(input.value); if (input.value.trim() === '') delete draft.options[o.name]; else if (Number.isFinite(v)) draft.options[o.name] = v; };
      } else { input = el('input', { type: 'text', value: typeof current === 'string' ? current : current === null || current === undefined ? '' : JSON.stringify(current) }); input.oninput = () => { const v = input.value.trim(); draft.options[o.name] = o.type === 'text' && !o.declared && v !== '' && Number.isFinite(Number(v)) ? Number(v) : input.value; }; }
      input.ariaLabel = o.label;
      body.append(el('label', { class: 'row script-option' }, el('span', { textContent: o.label }), input));
    }
  }

  const close = (): void => { ui.editing = null; ui.draft = null; redraw(); };
  const save = (): void => {
    const text = draft.source;
    // A pasted indicator file or workspace becomes the scripts it holds.
    if (text.trim().startsWith('{')) {
      const read = importText(text, cleanName(draft.name) ?? t('Pasted script'));
      if ('scripts' in read && read.scripts.length && read.scripts[0]!.source !== text.replace(/\r\n?/g, '\n')) {
        const list = host.records.filter(r => r.id !== existing?.id), merged = mergeScripts(list, read.scripts.map(s => ({ ...s, on: false })));
        ui.editing = null; ui.draft = null;
        keep(merged.list, tn(merged.added + merged.replaced, 'Read {n} script: switch it on to run it.', 'Read {n} scripts: switch them on to run them.'));
        return;
      }
    }
    const n = cleanName(draft.name) ?? cleanName(text.split('\n').find(l => l.trim())?.replace(/^\/\/\s*/, '').slice(0, 30)) ?? t('Script');
    const a = host.analysisOf({ ...probe, source: text });
    if (isError(a)) { say(errorText(a), true); return; }
    // Options it reads without declaring that nothing set yet get a value guessed from their names.
    const options = { ...draft.options };
    for (const o of optionRows(a, options)) if (!(o.name in options) && o.value !== '') options[o.name] = o.value;
    // What the script is now (it may have been switched off from its row or the map's legend while its editor was open), not when it opened.
    const now = existing ? host.records.find(r => r.id === existing.id) ?? existing : null;
    const record: ScriptRecord = { id: now?.id ?? newId(n), name: n, source: text.replace(/\r\n?/g, '\n'), options, on: now?.on ?? true, api: now?.api ?? SCRIPT_API, height: now?.height ?? ROW_DEFAULT, place: draft.place };
    const list = existing ? host.records.map(r => r.id === existing.id ? record : r) : [...host.records, record];
    if (!existing && host.records.length >= MAX_SCRIPTS) { say(t('At most {n} scripts: delete one first.', { n: MAX_SCRIPTS }), true); return; }
    ui.editing = record.id; ui.draft = { name: record.name, source: record.source, options: { ...record.options }, place: record.place };
    if (!existing) host.showScripts();
    keep(list, t('Saved “{name}”: it runs with the next update.', { name: record.name }));
  };
  const check = (): void => { const a = host.analysisOf({ ...probe, source: draft.source }); say(isError(a) ? errorText(a) : t('The script reads.'), isError(a)); };
  const forAi = (): void => {
    const text = aiBundle(bundleOf(host, draft, existing, probe));
    void copyText(text).then(ok => tell(ok ? t('Copied. Paste it into your AI assistant, then paste its answer back here and press Check.') : t('This browser did not let the page copy.'), !ok));
  };
  // Each keeps the keyboard when what it does rebuilds the panel.
  const tool = (label: string, act: () => void, tip: string, key: string): HTMLButtonElement => { const b = button(label, act, tip); b.dataset.focus = `script-${key}`; return b; };
  body.append(el('div', { class: 'layout-tools' },
    tool(t('Save'), save, t('Keep the script and run it'), 'save'),
    tool(t('Copy for AI'), forAi, t('Copy the script, its errors and what it drew, with the language\'s rules, to paste into an AI assistant'), 'ai'),
    tool(t('Check'), check, t('Read the script without saving it, to see whether it reads'), 'check'),
    tool(t('Back'), close, t('Back to the list (what is not saved is dropped)'), 'back')));
}

/**
 * What Copy for AI hands an assistant about the script in the editor: its text as it stands and the options set, the error that text meets
 * on reading, and the last run (its error, its warnings, each plot's newest values and the chart it worked on) only when the text and the
 * options are those that ran: with others it would have drawn something else.
 */
function bundleOf(host: ScriptsHost, draft: NonNullable<ScriptsPanelState['draft']>, existing: ScriptRecord | null, probe: ScriptRecord): BundleInput {
  const a = host.analysisOf({ ...probe, source: draft.source });
  const kept = existing ? host.records.find(r => r.id === existing.id) ?? null : null;
  const same = kept && kept.source === draft.source && sameOptions(kept.options, draft.options) ? kept : null;
  const ran = same ? host.resultOf(same.id) : null, on = same && ran?.ok ? host.ranOn(same.id) : null;
  const errors = isError(a) ? [a] : ran && !ran.ok ? [ran.error] : [];
  // A run's warnings hold the reading's; the page's own (an option not set, markets it has none of) come apart.
  const page = same ? host.warningsOf(same.id) : [];
  const warnings = isError(a) ? [] : ran?.ok ? [...page, ...ran.warnings] : [...a.warnings, ...page];
  const plots = ran?.ok && on ? ran.plots.map(p => ({ title: p.title, kind: p.kind, last: newestOf(p, on.candles) })) : [];
  return { name: draft.name, source: draft.source, place: draft.place, options: draft.options, errors, warnings, plots, chart: on };
}

/**
 * Put `text` on the clipboard: the browser's clipboard, else a selected text box copied the older way, the keyboard given back to where it
 * was. Whether it worked.
 */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* the older way below */ }
  const was = document.activeElement, box = el('textarea', { value: text });
  box.readOnly = true; box.style.position = 'fixed'; box.style.left = '-10000px'; box.style.top = '0'; box.style.opacity = '0';
  document.body.append(box); box.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { box.remove(); if (was instanceof HTMLElement && was.isConnected) was.focus({ preventScroll: true }); }
}
