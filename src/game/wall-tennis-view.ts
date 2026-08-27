// Rendering, input and the game loop for wall tennis. Everything here touches
// the DOM or the canvas, so none of it is unit tested --- it's playtested by
// hand instead. Physics and rules live in wall-tennis.ts.

import { ARENA_HEIGHT, ARENA_WIDTH, createInitialState, step, type GameState } from "./wall-tennis";

const FIXED_DT_MS = 1000 / 120; // physics substep, decoupled from the display's frame rate
const MAX_FRAME_MS = 250; // clamp a huge gap (backgrounded tab) instead of catching up in a burst

export function startWallTennis(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas context unavailable");
  const ctx = context;

  let state: GameState = createInitialState();
  let launched = false;
  let pointerX = ARENA_WIDTH / 2;
  let lastTime = 0;
  let accumulator = 0;
  let rafId = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  // Fit the logical 480x800 arena into whatever box the page gives the
  // canvas, letterboxed --- the same shape at 1920x1080 and at 390x844.
  function arenaTransform() {
    const scale = Math.min(canvas.width / ARENA_WIDTH, canvas.height / ARENA_HEIGHT);
    return {
      scale,
      offsetX: (canvas.width - ARENA_WIDTH * scale) / 2,
      offsetY: (canvas.height - ARENA_HEIGHT * scale) / 2,
    };
  }

  function toArenaX(clientX: number): number {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const { scale, offsetX } = arenaTransform();
    return ((clientX - rect.left) * dpr - offsetX) / scale;
  }

  function onPointer(event: PointerEvent) {
    pointerX = Math.max(0, Math.min(ARENA_WIDTH, toArenaX(event.clientX)));
    if (state.status === "lost") {
      state = createInitialState(pointerX);
    }
    launched = true;
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointermove", onPointer);

  function draw() {
    const { scale, offsetX, offsetY } = arenaTransform();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0a0a12";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);

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
    ctx.fillText(String(state.hits), ARENA_WIDTH / 2, 44);

    ctx.restore();
  }

  function frame(time: number) {
    if (!lastTime) lastTime = time;
    const elapsed = Math.min(time - lastTime, MAX_FRAME_MS);
    lastTime = time;

    if (state.status === "playing" && launched) {
      accumulator += elapsed;
      while (accumulator >= FIXED_DT_MS) {
        state = step(state, FIXED_DT_MS, pointerX);
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

    draw();
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
