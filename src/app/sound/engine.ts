import type { Note } from './rules.ts';

export type EngineState = 'unsupported' | 'locked' | 'running';

/**
 * Plays notes with the Web Audio API: one context, a master gain and a compressor that protects the speakers when several sounds
 * overlap. Everything is scheduled on the audio clock (no timers), voices are bounded, and nothing plays while the browser still
 * holds the context suspended (it only lets go after a click or key press), so a locked page is silent rather than queueing.
 */
export class SoundEngine {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #voices = 0;
  /** Most notes sounding at once; further ones are dropped, not queued. */
  readonly maxVoices = 8;
  /** Notes dropped because too many were already sounding. */
  dropped = 0;
  #volume = 1;

  get state(): EngineState {
    if (typeof AudioContext === 'undefined') return 'unsupported';
    return this.#ctx?.state === 'running' ? 'running' : 'locked';
  }

  setVolume(volume: number): void { this.#volume = Math.min(1, Math.max(0, volume)); if (this.#master) this.#master.gain.value = this.#volume; }

  /** Create the context if needed and ask the browser to start it. Call from a click or key press. */
  async unlock(): Promise<EngineState> {
    if (typeof AudioContext === 'undefined') return 'unsupported';
    if (!this.#ctx) {
      this.#ctx = new AudioContext({ latencyHint: 'interactive' });
      const compressor = this.#ctx.createDynamicsCompressor();
      compressor.threshold.value = -18; compressor.knee.value = 12; compressor.ratio.value = 6; compressor.attack.value = 0.003; compressor.release.value = 0.2;
      this.#master = this.#ctx.createGain(); this.#master.gain.value = this.#volume;
      this.#master.connect(compressor).connect(this.#ctx.destination);
    }
    if (this.#ctx.state !== 'running') { try { await this.#ctx.resume(); } catch { /* still locked: the next gesture tries again */ } }
    return this.state;
  }

  /** Schedule the notes now; returns false when nothing could be played (locked, unsupported, or too many voices). `force` ignores the voice limit (an explicit Test click should always sound). */
  play(notes: readonly Note[], force = false): boolean {
    const ctx = this.#ctx, master = this.#master;
    if (!ctx || !master || ctx.state !== 'running') return false;
    let played = 0;
    const start = ctx.currentTime + 0.01;
    for (const note of notes) {
      if (!(note.gain > 0)) continue;
      if (!force && this.#voices >= this.maxVoices) { this.dropped++; continue; }
      const t = start + note.delay, end = t + note.decay;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = note.wave; osc.frequency.value = note.freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(note.gain, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(master);
      this.#voices++;
      osc.onended = () => { this.#voices--; gain.disconnect(); };
      osc.start(t); osc.stop(end + 0.03);
      played++;
    }
    return played > 0;
  }
}
