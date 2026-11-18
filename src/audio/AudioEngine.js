import { AUDIO_CONFIG } from '../config/constants.js';
import { safeGetStorageItem, safeSetStorageItem } from '../utils/storage.js';

export class AudioEngine {
  #ctx = null;
  #masterGain = null;
  #volumePct = AUDIO_CONFIG.DEFAULT_VOLUME;
  #isMuted = false;
  #lastSoundedRound = -1;
  #lastSoundedSeq = -1;

  constructor() {
    const savedVol = Number(safeGetStorageItem(AUDIO_CONFIG.STORAGE_VOL_KEY));
    if (!Number.isNaN(savedVol) && savedVol >= 0 && savedVol <= 100) {
      this.#volumePct = Math.round(savedVol);
    }
    this.#isMuted = safeGetStorageItem(AUDIO_CONFIG.STORAGE_MUTE_KEY) === 'true';
  }

  get volumePct() {
    return this.#volumePct;
  }

  get isMuted() {
    return this.#isMuted;
  }

  get isEffectivelyMuted() {
    return this.#isMuted || this.#volumePct <= 0;
  }

  unlock() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;

    if (!this.#ctx) {
      this.#ctx = new AudioCtx();
      this.#masterGain = this.#ctx.createGain();
      this.#masterGain.gain.value = this.#getEffectiveGain();
      this.#masterGain.connect(this.#ctx.destination);
    }

    if (this.#ctx.state === 'suspended') {
      this.#ctx.resume().catch(() => {});
    }

    return this.#ctx;
  }

  toggleMute() {
    this.unlock();
    this.#isMuted = !this.#isMuted;
    this.#persistAndApply();
  }

  setVolume(pct) {
    this.unlock();
    this.#volumePct = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    if (this.#volumePct > 0 && this.#isMuted) {
      this.#isMuted = false;
    }
    this.#persistAndApply();
  }

  resetHitDeduplication() {
    this.#lastSoundedRound = -1;
    this.#lastSoundedSeq = -1;
  }

  syncHitDeduplication(round, seq) {
    this.#lastSoundedRound = round;
    this.#lastSoundedSeq = seq;
  }

  playPaddleHitOnce(round, seq, side, speed) {
    if (round < this.#lastSoundedRound) return;
    if (round === this.#lastSoundedRound && seq <= this.#lastSoundedSeq) return;

    this.#lastSoundedRound = round;
    this.#lastSoundedSeq = seq;
    this.playPaddleHit(side, speed);
  }

  playPaddleHit(side, speed = 340) {
    const base = side === 'left' ? 440 : 520;
    const boost = Math.min(180, Math.max(0, (speed - 340) * 0.35));
    const freq = base + boost;
    this.#playTone({
      freq,
      endFreq: freq * 0.88,
      duration: 0.06,
      type: 'square',
      gain: 0.24
    });
  }

  playWallBounce() {
    this.#playTone({ freq: 240, endFreq: 190, duration: 0.045, type: 'triangle', gain: 0.22 });
  }

  playServe() {
    this.#playTone({ freq: 620, endFreq: 760, duration: 0.04, type: 'triangle', gain: 0.18 });
  }

  playScore(won) {
    if (won) {
      this.#playTone({ freq: 523.25, duration: 0.09, type: 'triangle', gain: 0.3, delay: 0 });
      this.#playTone({ freq: 783.99, duration: 0.16, type: 'triangle', gain: 0.32, delay: 0.08 });
    } else {
      this.#playTone({ freq: 329.63, duration: 0.1, type: 'sawtooth', gain: 0.16, delay: 0 });
      this.#playTone({ freq: 220.0, duration: 0.18, type: 'sawtooth', gain: 0.16, delay: 0.09 });
    }
  }

  playPause(isPaused) {
    if (isPaused) {
      this.#playTone({ freq: 380, endFreq: 260, duration: 0.07, type: 'triangle', gain: 0.2 });
    } else {
      this.#playTone({ freq: 300, endFreq: 460, duration: 0.07, type: 'triangle', gain: 0.2 });
    }
  }

  playConnect() {
    this.#playTone({ freq: 523.25, duration: 0.07, type: 'sine', gain: 0.22, delay: 0 });
    this.#playTone({ freq: 659.25, duration: 0.11, type: 'sine', gain: 0.22, delay: 0.065 });
  }

  playDisconnect() {
    this.#playTone({ freq: 260, duration: 0.1, type: 'triangle', gain: 0.24, delay: 0 });
    this.#playTone({ freq: 185, duration: 0.16, type: 'triangle', gain: 0.24, delay: 0.1 });
  }

  #getEffectiveGain() {
    if (this.isEffectivelyMuted) return 0;
    return Math.pow(this.#volumePct / 100, AUDIO_CONFIG.GAIN_CURVE) * AUDIO_CONFIG.MAX_GAIN;
  }

  #persistAndApply() {
    safeSetStorageItem(AUDIO_CONFIG.STORAGE_VOL_KEY, this.#volumePct);
    safeSetStorageItem(AUDIO_CONFIG.STORAGE_MUTE_KEY, this.#isMuted);
    if (this.#masterGain && this.#ctx) {
      this.#masterGain.gain.setTargetAtTime(
        this.#getEffectiveGain(),
        this.#ctx.currentTime,
        0.01
      );
    }
  }

  #playTone({ freq, endFreq = null, duration = 0.08, type = 'square', gain = 0.3, delay = 0 }) {
    if (this.isEffectivelyMuted) return;
    const ac = this.unlock();
    if (!ac || ac.state !== 'running') return;

    const t0 = ac.currentTime + delay;
    const t1 = t0 + duration;

    const osc = ac.createOscillator();
    const env = ac.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t1);
    }

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t1);

    osc.connect(env);
    env.connect(this.#masterGain);

    osc.start(t0);
    osc.stop(t1 + 0.01);
  }
}
