import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { clock } from '../format.ts';
import { helpButton } from '../help.ts';
import type { Store } from '../store.ts';
import { REPLAY_SPEEDS, caughtUp, pageNow, pauseReplay, playReplay, replayView, replaying, setReplaySpeed, startReplay, stopReplay, type ReplaySpeed } from './clock.ts';

/** The moment shown, to the second (seconds are the same on every clock). */
const withSeconds = (t: number): string => `${clock(t, true)}:${String(new Date(t).getUTCSeconds()).padStart(2, '0')}`;

/**
 * The replay's controls, on the map above its time axis: play or pause, the speed, the moment shown, and Live (back to now). While it
 * runs the map is drawn about four times a second (the panes under it follow the map's frames); it never touches the store per tick.
 */
export class ReplayBar {
  readonly root = el('div', { class: 'replay-bar', hidden: true });
  #play = el('button', { type: 'button', class: 'replay-play', ariaLabel: t('Pause') });
  #speed = el('select', { ariaLabel: t('Speed') });
  #time = el('span', { class: 'replay-time' });
  #frame = 0;
  #lastDraw = 0;

  #hideTimer = 0;

  constructor(private store: Store, private host: { redraw(): void; placeAt(t: number): void; live(): void }) {
    for (const s of REPLAY_SPEEDS) this.#speed.append(new Option(`${s}×`, String(s)));
    this.#speed.onchange = () => { setReplaySpeed(Number(this.#speed.value) as ReplaySpeed); this.#sync(); };
    this.#play.onclick = () => { if (replayView()?.playing) pauseReplay(); else playReplay(); this.#sync(); };
    const live = el('button', { type: 'button', class: 'replay-live', textContent: t('Live'), tip: t('Leave the replay and go back to now') });
    live.onclick = () => this.stop();
    this.root.append(el('strong', { textContent: t('Replay') }), this.#play, this.#speed, this.#time, live, helpButton('replay'));
    // A hidden tab draws nothing: the replay waits for it, rather than jumping on by the time it was away.
    document.addEventListener('visibilitychange', () => {
      if (!replaying()) return;
      if (document.hidden) { if (replayView()?.playing) { pauseReplay(); this.#autoPaused = true; this.#sync(); } }
      else if (this.#autoPaused) { this.#autoPaused = false; playReplay(); this.#sync(); }
    });
  }
  #autoPaused = false;

  /** Replay from `from` (already within what is held): the map's live edge becomes that moment and moves on at the chosen speed. */
  start(from: number, speed: ReplaySpeed = 10): void {
    window.clearTimeout(this.#hideTimer);
    startReplay(from, speed);
    this.host.placeAt(from);
    this.root.hidden = false; this.root.classList.remove('ended');
    this.#sync();
  }

  /** Back to live; with a `note`, the bar says it for a few seconds before it goes. */
  stop(note = ''): void {
    if (!replaying()) return;
    stopReplay();
    cancelAnimationFrame(this.#frame); this.#frame = 0;
    this.store.set({ replay: null });
    this.host.live();
    if (!note) { this.root.hidden = true; return; }
    this.root.classList.add('ended'); this.#time.textContent = note;
    this.#hideTimer = window.setTimeout(() => { this.root.hidden = true; this.root.classList.remove('ended'); }, 4_000);
  }

  #sync(): void {
    const view = replayView();
    this.store.set({ replay: view });
    if (!view) return;
    this.#play.classList.toggle('paused', !view.playing);
    this.#play.ariaLabel = view.playing ? t('Pause') : t('Play');
    this.#play.dataset.tip = view.playing ? t('Pause') : t('Play');
    if (this.#speed.value !== String(view.speed)) this.#speed.value = String(view.speed);
    this.#time.textContent = withSeconds(pageNow());
    if (view.playing && !this.#frame) this.#frame = requestAnimationFrame(this.#tick);
  }

  #tick = (): void => {
    this.#frame = 0;
    if (!replaying()) return;
    if (caughtUp()) { this.stop(t('The replay caught up with now: live again.')); return; }
    const now = performance.now();
    if (now - this.#lastDraw >= 250 && document.visibilityState === 'visible') {
      this.#lastDraw = now;
      const text = withSeconds(pageNow());
      if (this.#time.textContent !== text) this.#time.textContent = text;
      if (replayView()?.playing) this.host.redraw();
    }
    // Paused: nothing moves, so no frames; play asks for them again (#sync).
    if (replayView()?.playing) this.#frame = requestAnimationFrame(this.#tick);
  };
}
