// Rendering, input and the game loop for wall tennis. Everything here touches
// the DOM or the canvas, so none of it is unit tested --- it's playtested by
// hand instead. Physics and rules live in wall-tennis.ts.

import { ARENA_HEIGHT, PADDLE_Y, createInitialState, step, type GameState } from "./wall-tennis";

const FIXED_DT_MS = 1000 / 120; // physics substep, decoupled from the display's frame rate
const MAX_FRAME_MS = 250; // clamp a huge gap (backgrounded tab) instead of catching up in a burst

// Grass-court dressing: mown stripes plus the real markings (doubles and
// singles sidelines, baseline, service line and box, center mark) scaled to
// whatever width the arena ends up at. Purely cosmetic --- none of this
// feeds back into where the ball or paddle can go.
const STRIPE_COUNT = 10;
const GRASS_LIGHT = "#5da33a";
const GRASS_DARK = "#4f9231";
const LINE_COLOR = "#f5f5f0";
const LINE_WIDTH = 3;
const DOUBLES_MARGIN_RATIO = 0.06;
const SINGLES_MARGIN_RATIO = 0.14;
const SERVICE_LINE_Y = ARENA_HEIGHT * 0.55;
const CENTER_MARK_LENGTH = 10;

function drawCourt(ctx: CanvasRenderingContext2D, arenaWidth: number) {
  const stripeWidth = arenaWidth / STRIPE_COUNT;
  for (let i = 0; i < STRIPE_COUNT; i++) {
    ctx.fillStyle = i % 2 === 0 ? GRASS_LIGHT : GRASS_DARK;
    ctx.fillRect(i * stripeWidth, 0, stripeWidth, ARENA_HEIGHT);
  }

  const doublesMargin = arenaWidth * DOUBLES_MARGIN_RATIO;
  const singlesMargin = arenaWidth * SINGLES_MARGIN_RATIO;
  const centerX = arenaWidth / 2;

  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = LINE_WIDTH;

  // Sidelines stop at the baseline --- they mark the court, not the strip of
  // screen behind the player.
  ctx.beginPath();
  ctx.moveTo(doublesMargin, 0);
  ctx.lineTo(doublesMargin, PADDLE_Y);
  ctx.moveTo(arenaWidth - doublesMargin, 0);
  ctx.lineTo(arenaWidth - doublesMargin, PADDLE_Y);
  ctx.moveTo(singlesMargin, 0);
  ctx.lineTo(singlesMargin, PADDLE_Y);
  ctx.moveTo(arenaWidth - singlesMargin, 0);
  ctx.lineTo(arenaWidth - singlesMargin, PADDLE_Y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(doublesMargin, PADDLE_Y);
  ctx.lineTo(arenaWidth - doublesMargin, PADDLE_Y);
  ctx.moveTo(singlesMargin, SERVICE_LINE_Y);
  ctx.lineTo(arenaWidth - singlesMargin, SERVICE_LINE_Y);
  ctx.moveTo(centerX, 0);
  ctx.lineTo(centerX, SERVICE_LINE_Y);
  ctx.moveTo(centerX, PADDLE_Y - CENTER_MARK_LENGTH);
  ctx.lineTo(centerX, PADDLE_Y);
  ctx.stroke();
}

export function startWallTennis(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas context unavailable");
  const ctx = context;

  let pointerX = 0;
  let lastTime = 0;
  let accumulator = 0;
  let rafId = 0;
  let launched = false;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  // Fixed height, width matched to whatever aspect ratio the screen actually
  // is --- the arena fills the canvas edge to edge on a laptop and on a
  // phone alike, rather than sitting letterboxed at one fixed shape.
  function arenaTransform() {
    const scale = canvas.height / ARENA_HEIGHT;
    return { scale, arenaWidth: canvas.width / scale };
  }

  function toArenaX(clientX: number): number {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const { scale } = arenaTransform();
    return ((clientX - rect.left) * dpr) / scale;
  }

  resize();
  let state: GameState = createInitialState(arenaTransform().arenaWidth);
  pointerX = state.paddle.x;

  function onPointer(event: PointerEvent) {
    const { arenaWidth } = arenaTransform();
    pointerX = Math.max(0, Math.min(arenaWidth, toArenaX(event.clientX)));
    if (state.status === "lost") {
      state = createInitialState(arenaWidth, pointerX);
    }
    launched = true;
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointermove", onPointer);

  function draw(scale: number, arenaWidth: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = GRASS_DARK;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(scale, scale);

    drawCourt(ctx, arenaWidth);

    ctx.globalAlpha = state.status === "lost" ? 0.4 : 1;

    ctx.beginPath();
    ctx.fillStyle = "#f8fafc";
    ctx.arc(state.ball.x, state.ball.y, state.ball.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(
      state.paddle.x - state.paddle.width / 2,
      state.paddle.y - state.paddle.height / 2,
      state.paddle.width,
      state.paddle.height,
    );

    ctx.globalAlpha = 1;
    ctx.fillStyle = "#f8fafc";
    ctx.font = "28px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(state.hits), arenaWidth / 2, 44);

    ctx.restore();
  }

  function frame(time: number) {
    if (!lastTime) lastTime = time;
    const elapsed = Math.min(time - lastTime, MAX_FRAME_MS);
    lastTime = time;

    const { scale, arenaWidth } = arenaTransform();

    if (state.status === "playing" && launched) {
      accumulator += elapsed;
      while (accumulator >= FIXED_DT_MS) {
        state = step(state, FIXED_DT_MS, pointerX, arenaWidth);
        accumulator -= FIXED_DT_MS;
      }
    } else if (state.status === "playing") {
      // Not launched yet: the ball rides the paddle so the opening frame
      // reads as "aim, then go" with no caption needed.
      const paddle = { ...state.paddle, x: pointerX };
      state = {
        ...state,
        paddle,
        ball: { ...state.ball, x: pointerX, y: paddle.y - paddle.height / 2 - state.ball.radius },
      };
    }

    draw(scale, arenaWidth);
    rafId = requestAnimationFrame(frame);
  }

  rafId = requestAnimationFrame(frame);

  return function cleanup() {
    cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    canvas.removeEventListener("pointerdown", onPointer);
    canvas.removeEventListener("pointermove", onPointer);
  };
}
