import { GAME_CONFIG } from '../config/constants.js';
import { isEditableElement } from '../utils/dom.js';

export class InputController {
  #canvas;
  #handlers;
  #keys = { up: false, down: false };
  #abortController = new AbortController();

  constructor(canvas, handlers) {
    this.#canvas = canvas;
    this.#handlers = handlers;
    this.#bindEvents();
  }

  getVerticalDirection() {
    return (this.#keys.down ? 1 : 0) - (this.#keys.up ? 1 : 0);
  }

  resetKeys() {
    this.#keys.up = false;
    this.#keys.down = false;
  }

  destroy() {
    this.#abortController.abort();
  }

  #bindEvents() {
    const { signal } = this.#abortController;

    window.addEventListener('keydown', (e) => {
      this.#handlers.onUserGesture?.();

      if (isEditableElement(document.activeElement)) return;

      if (e.key === 'm' || e.key === 'M') {
        if (!e.repeat) this.#handlers.onToggleMute?.();
        return;
      }

      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (!e.repeat) this.#handlers.onTogglePause?.();
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
      }
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
        this.#keys.up = true;
      }
      if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
        this.#keys.down = true;
      }
    }, { signal });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') this.#keys.up = false;
      if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') this.#keys.down = false;
    }, { signal });

    window.addEventListener('blur', () => {
      this.resetKeys();
    }, { signal });

    const handlePointer = (e) => {
      if (e.type === 'pointerdown') {
        this.#handlers.onUserGesture?.();
      }
      const rect = this.#canvas.getBoundingClientRect();
      if (rect.height <= 0) return;
      const y = (e.clientY - rect.top) * (GAME_CONFIG.HEIGHT / rect.height) - GAME_CONFIG.PADDLE_HEIGHT / 2;
      this.#handlers.onPointerMove?.(y);
    };

    this.#canvas.addEventListener('pointerdown', handlePointer, { signal });
    this.#canvas.addEventListener('pointermove', handlePointer, { signal });
  }
}
