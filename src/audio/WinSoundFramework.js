export class WinSoundFramework {
  #sounds = new Map();

  /**
   * Registers a pre-made win sound definition.
   * `play(synth)` receives `{ tone, sequence, chord, ctx, destination }`.
   */
  register(definition) {
    if (!definition || typeof definition.id !== 'string' || !definition.id.trim()) {
      throw new Error('Win sound definition must have a non-empty string id.');
    }
    if (typeof definition.play !== 'function') {
      throw new Error(`Win sound "${definition.id}" must provide a play(synth) function.`);
    }

    const id = definition.id.trim();
    this.#sounds.set(id, {
      id,
      label: definition.label || id,
      description: definition.description || '',
      play: definition.play
    });
    return this;
  }

  unregister(id) {
    return this.#sounds.delete(id);
  }

  has(id) {
    return this.#sounds.has(id);
  }

  get(id) {
    return this.#sounds.get(id) || null;
  }

  list() {
    return Array.from(this.#sounds.values());
  }

  play(id, synth, fallbackId = 'classic') {
    const entry = this.#sounds.get(id);
    if (entry) {
      const result = entry.play(synth);
      if (result !== false) return true;
    }

    if (fallbackId && fallbackId !== id && this.#sounds.has(fallbackId)) {
      return this.#sounds.get(fallbackId).play(synth) !== false;
    }

    return false;
  }
}

export function createDefaultWinSoundFramework() {
  const framework = new WinSoundFramework();

  framework
    .register({
      id: 'classic',
      label: 'Classic Fanfare',
      description: 'Bright rising major arpeggio',
      play: (synth) => {
        synth.sequence(
          [
            { freq: 523.25, duration: 0.09, delay: 0.0 },
            { freq: 659.25, duration: 0.09, delay: 0.085 },
            { freq: 783.99, duration: 0.09, delay: 0.17 },
            { freq: 1046.5, duration: 0.28, delay: 0.255, gain: 0.34 }
          ],
          { type: 'triangle', gain: 0.28 }
        );
      }
    })
    .register({
      id: 'arcade',
      label: '8-Bit Victory',
      description: 'Retro chiptune victory riff',
      play: (synth) => {
        synth.sequence(
          [
            { freq: 392.0, duration: 0.075, delay: 0.0 },
            { freq: 523.25, duration: 0.075, delay: 0.08 },
            { freq: 659.25, duration: 0.075, delay: 0.16 },
            { freq: 783.99, duration: 0.11, delay: 0.24 },
            { freq: 659.25, duration: 0.075, delay: 0.37 },
            { freq: 783.99, duration: 0.075, delay: 0.45 },
            { freq: 1046.5, duration: 0.32, delay: 0.54, gain: 0.28 }
          ],
          { type: 'square', gain: 0.2 }
        );
      }
    })
    .register({
      id: 'powerup',
      label: 'Turbo Power-Up',
      description: 'Rapid ascending synth burst',
      play: (synth) => {
        const freqs = [330, 415.3, 493.88, 659.25, 830.61, 987.77, 1318.51];
        freqs.forEach((freq, idx) => {
          synth.tone({
            freq,
            endFreq: freq * 1.03,
            duration: idx === freqs.length - 1 ? 0.26 : 0.055,
            type: 'triangle',
            gain: idx === freqs.length - 1 ? 0.32 : 0.22,
            delay: idx * 0.048
          });
        });
      }
    })
    .register({
      id: 'chime',
      label: 'Crystal Chimes',
      description: 'Harmonic bell cascade',
      play: (synth) => {
        synth.sequence(
          [
            { freq: 523.25, duration: 0.25, delay: 0.0 },
            { freq: 659.25, duration: 0.25, delay: 0.06 },
            { freq: 783.99, duration: 0.28, delay: 0.12 },
            { freq: 987.77, duration: 0.3, delay: 0.18 },
            { freq: 1046.5, duration: 0.42, delay: 0.24 }
          ],
          { type: 'sine', gain: 0.24 }
        );
      }
    })
    .register({
      id: 'synth-brass',
      label: 'Victory Chord',
      description: 'Stadium synth chord hit',
      play: (synth) => {
        synth.chord([392.0, 493.88, 587.33], { duration: 0.14, type: 'sawtooth', gain: 0.11, delay: 0 });
        synth.chord([523.25, 659.25, 783.99, 1046.5], {
          duration: 0.4,
          type: 'sawtooth',
          gain: 0.11,
          delay: 0.16
        });
      }
    })
    .register({
      id: 'retro-blip',
      label: 'Clean Double Ping',
      description: 'Minimalist high chime',
      play: (synth) => {
        synth.tone({ freq: 783.99, duration: 0.09, type: 'sine', gain: 0.28, delay: 0 });
        synth.tone({ freq: 1174.66, duration: 0.22, type: 'sine', gain: 0.3, delay: 0.1 });
      }
    })
    .register({
      id: 'silent',
      label: 'None (Silent)',
      description: 'No sound on match win',
      play: () => true
    });

  return framework;
}