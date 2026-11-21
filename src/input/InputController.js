import { GAME_CONFIG } from '../config/constants.js';
import { isEditableElement } from '../utils/dom.js';

const BLOCKED_SELECTOR =
  'button, a, input, select, textarea, label, summary, .dropdown-popover, .ledger-panel';

export class InputController {
  #canvas;
  #handlers;
  #keys = { up: false, down: false };
  #pointerOnControl = false;
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

  #isBlockedTarget(target) {
    return (
      target instanceof Element &&
      (isEditableElement(target) || Boolean(target.closest(BLOCKED_SELECTOR)))
    );
  }

  #bindEvents() {
    const { signal } = this.#abortController;

    window.addEventListener(
      'keydown',
      (e) => {
        this.#handlers.onUserGesture?.();

        if (isEditableElement(document.activeElement)) return;

        if (e.key === 'm' || e.key === 'M') {
          if (!e.repeat) this.#handlers.onToggleMute?.();
          return;
        }

        if (e.code === 'Space' || e.key === ' ') {
          e.preventDefault();
          if (!e.repeat) {
            this.#handlers.onSpacePress?.();
          }
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
      },
      { signal }
    );

    window.addEventListener(
      'keyup',
      (e) => {
        if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') this.#keys.up = false;
        if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') this.#keys.down = false;
      },
      { signal }
    );

    window.addEventListener(
      'blur',
      () => {
        this.resetKeys();
        this.#pointerOnControl = false;
      },
      { signal }
    );

    const clearControlDrag = () => {
      this.#pointerOnControl = false;
    };
    window.addEventListener('pointerup', clearControlDrag, { signal });
    window.addEventListener('pointercancel', clearControlDrag, { signal });

    const handlePointer = (e) => {
      const blocked = this.#isBlockedTarget(e.target);

      if (e.type === 'pointerdown') {
        this.#pointerOnControl = blocked;
        if (blocked) return;
        this.#handlers.onUserGesture?.();
      } else if (this.#pointerOnControl || blocked) {
        return;
      }

      const rect = this.#canvas.getBoundingClientRect();
      if (rect.height <= 0) return;

      const rawY =
        (e.clientY - rect.top) * (GAME_CONFIG.HEIGHT / rect.height) - GAME_CONFIG.PADDLE_HEIGHT / 2;
      const y = Math.max(0, Math.min(GAME_CONFIG.HEIGHT - GAME_CONFIG.PADDLE_HEIGHT, rawY));

      this.#handlers.onPointerMove?.(y);
    };

    window.addEventListener('pointerdown', handlePointer, { signal });
    window.addEventListener('pointermove', handlePointer, { signal });
  }
}
