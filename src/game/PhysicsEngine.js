import { COURT_BOUNDS, GAME_CONFIG, NETWORK_CONFIG } from '../config/constants.js';

function clamp(min, max, val) {
  return Math.max(min, Math.min(max, val));
}

export class PhysicsEngine {
  /**
   * Advances the ball simulation by `dt` using fixed sub-steps to prevent tunneling.
   * Returns an object summarizing events that occurred during the frame.
   */
  step(state, dt, callbacks = {}) {
    if (state.waitingForServe) return;

    if (state.serveTimer > 0) {
      state.serveTimer = Math.max(0, state.serveTimer - dt);
      if (state.serveTimer === 0) {
        callbacks.onServeStart?.();
      }
      return;
    }

    let remaining = dt;
    let wallBounced = false;

    while (remaining > 1e-6) {
      const sub = Math.min(remaining, GAME_CONFIG.MAX_SUBSTEP);
      remaining -= sub;

      const { event, bouncedWall } = this.#stepSubstep(state, sub);
      if (bouncedWall) wallBounced = true;

      if (event === 'hit-left' || event === 'hit-right') {
        callbacks.onPaddleHit?.(event === 'hit-left' ? 'left' : 'right');
      } else if (event === 'miss-left') {
        if (callbacks.onMiss?.('left')) break;
      } else if (event === 'miss-right') {
        if (callbacks.onMiss?.('right')) break;
      }
    }

    if (wallBounced) {
      callbacks.onWallBounce?.();
    }
  }

  /**
   * Advances the ball visually for half-RTT compensation without triggering scoring.
   */
  advanceVisual(state, duration) {
    let remaining = Math.min(Math.max(duration, 0), NETWORK_CONFIG.MAX_VISUAL_ADVANCE);
    while (remaining > 1e-6) {
      const sub = Math.min(remaining, GAME_CONFIG.MAX_SUBSTEP);
      remaining -= sub;
      state.ballX += state.vx * sub;
      state.ballY += state.vy * sub;
      this.#bounceVerticalWalls(state);
    }
  }

  #stepSubstep(state, dt) {
    const prevX = state.ballX;
    const prevY = state.ballY;

    state.ballX += state.vx * dt;
    state.ballY += state.vy * dt;

    const bouncedWall = this.#bounceVerticalWalls(state);

    if (this.#resolvePaddleCollision(state, prevX, prevY, 'left')) {
      return { event: 'hit-left', bouncedWall };
    }
    if (this.#resolvePaddleCollision(state, prevX, prevY, 'right')) {
      return { event: 'hit-right', bouncedWall };
    }

    const r = GAME_CONFIG.BALL_RADIUS;
    if (state.ballX + r < 0) return { event: 'miss-left', bouncedWall };
    if (state.ballX - r > GAME_CONFIG.WIDTH) return { event: 'miss-right', bouncedWall };

    return { event: null, bouncedWall };
  }

  #bounceVerticalWalls(state) {
    const r = GAME_CONFIG.BALL_RADIUS;
    const maxY = GAME_CONFIG.HEIGHT - r;

    if (state.ballY - r < 0) {
      state.ballY = r;
      state.vy *= -1;
      return true;
    }
    if (state.ballY + r > GAME_CONFIG.HEIGHT) {
      state.ballY = maxY;
      state.vy *= -1;
      return true;
    }
    return false;
  }

  /**
   * Swept collision check parameterized for either 'left' or 'right' paddle.
   */
  #resolvePaddleCollision(state, prevX, prevY, side) {
    const isLeft = side === 'left';
    const bounceDir = isLeft ? 1 : -1;
    const travelDir = -bounceDir;

    if (state.vx * travelDir <= 0) return false;

    const r = GAME_CONFIG.BALL_RADIUS;
    const faceX = isLeft ? COURT_BOUNDS.LEFT_FACE : COURT_BOUNDS.RIGHT_FACE;
    const paddleY = isLeft ? state.hostY : state.guestY;

    const prevDist = (prevX - faceX) * bounceDir;
    const currDist = (state.ballX - faceX) * bounceDir;
    if (prevDist < r - 2 || currDist > r) return false;

    const targetX = faceX + r * bounceDir;
    const dx = state.ballX - prevX;
    const frac = dx !== 0 ? clamp(0, 1, (targetX - prevX) / dx) : 0;
    const impactY = prevY + (state.ballY - prevY) * frac;

    if (impactY < paddleY - r || impactY > paddleY + GAME_CONFIG.PADDLE_HEIGHT + r) {
      return false;
    }

    const halfPaddle = GAME_CONFIG.PADDLE_HEIGHT / 2;
    const hitOffset = clamp(-1, 1, (impactY - (paddleY + halfPaddle)) / halfPaddle);
    const speed = Math.min(
      Math.hypot(state.vx, state.vy) * GAME_CONFIG.SPEED_MULTIPLIER,
      GAME_CONFIG.MAX_BALL_SPEED
    );
    const angle = hitOffset * GAME_CONFIG.MAX_BOUNCE_ANGLE;

    state.vx = bounceDir * Math.cos(angle) * speed;
    state.vy = Math.sin(angle) * speed;
    state.ballX = targetX;
    state.ballY = clamp(r, GAME_CONFIG.HEIGHT - r, impactY);

    return true;
  }
}
