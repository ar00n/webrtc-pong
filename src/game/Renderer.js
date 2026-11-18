import { GAME_CONFIG } from '../config/constants.js';

export class Renderer {
  #canvas;
  #ctx;
  #dpr = 1;

  constructor(canvas) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d');
    this.#syncResolution();
  }

  render(state, view) {
    this.#syncResolution();
    const ctx = this.#ctx;
    const { WIDTH: W, HEIGHT: H, PADDLE_MARGIN, PADDLE_WIDTH, PADDLE_HEIGHT, BALL_RADIUS } = GAME_CONFIG;

    // Background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // Center dashed line
    ctx.strokeStyle = '#333';
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.setLineDash([]);

    // Scores
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(state.hostScore), W * 0.25, 48);
    ctx.fillText(String(state.guestScore), W * 0.75, 48);

    if (view.inRoom) {
      ctx.fillStyle = '#555';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('YOU', view.isHost ? W * 0.25 : W * 0.75, 68);
    }

    // Paddles
    ctx.fillStyle = '#fff';
    ctx.fillRect(PADDLE_MARGIN, state.hostY, PADDLE_WIDTH, PADDLE_HEIGHT);
    ctx.fillRect(W - PADDLE_MARGIN - PADDLE_WIDTH, state.guestY, PADDLE_WIDTH, PADDLE_HEIGHT);

    // Ball
    const drawBx = state.ballX + state.visErrX;
    const drawBy = Math.max(BALL_RADIUS, Math.min(H - BALL_RADIUS, state.ballY + state.visErrY));
    ctx.beginPath();
    ctx.arc(drawBx, drawBy, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // Status overlay
    if (view.overlay) {
      this.#drawOverlay(view.overlay.title, view.overlay.subtitle, view.overlay.accentColor);
    }
  }

  #syncResolution() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(GAME_CONFIG.WIDTH * dpr);
    const targetH = Math.round(GAME_CONFIG.HEIGHT * dpr);

    if (this.#canvas.width !== targetW || this.#canvas.height !== targetH || this.#dpr !== dpr) {
      this.#dpr = dpr;
      this.#canvas.width = targetW;
      this.#canvas.height = targetH;
      this.#canvas.style.width = `${GAME_CONFIG.WIDTH}px`;
    }
    this.#ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
  }

  #drawOverlay(title, subtitle, accentColor = '#fff') {
    const ctx = this.#ctx;
    const { WIDTH: W, HEIGHT: H } = GAME_CONFIG;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.fillStyle = accentColor;
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.fillText(title, W / 2, H / 2 - 10);

    if (subtitle) {
      ctx.fillStyle = '#ccc';
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillText(subtitle, W / 2, H / 2 + 22);
    }
  }
}
