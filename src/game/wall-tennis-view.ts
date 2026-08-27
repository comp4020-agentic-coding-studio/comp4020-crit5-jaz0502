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

// A tilted, pixel-art racquet in place of the old plain vector ellipse. It's
// drawn once at high resolution with gradients and curves, then pixelated by
// point-sampling it down to a tiny canvas and scaling that back up with
// smoothing off --- the standard trick for getting hard-edged "pixel art"
// out of ordinary smooth canvas drawing instead of hand-placing squares.
//
// The sprite is authored upright (head up, handle down) in its own local
// "art space"; TILT_ANGLE rotates the whole thing at draw time. Tilting an
// ellipse shrinks its sideways reach, so the draw scale is solved backwards
// from the angle to make the head's horizontal footprint always come out to
// exactly paddle.width --- the ball's bounce math in wall-tennis.ts only
// knows about that invisible rectangle, so the drawing has to keep matching
// it regardless of how it's rotated.
const ART_WIDTH = 400;
const ART_HEIGHT = 708;
const HEAD_CENTER_X_FRAC = 0.5;
const HEAD_CENTER_Y_FRAC = 170 / 460;
const HEAD_RADIUS_X_FRAC = 90 / 260;
const HEAD_RADIUS_Y_FRAC = 115 / 460;
const PIXEL_ART_WIDTH = 40; // resolution of the downsampled sprite --- lower is chunkier
const TILT_ANGLE = (-32 * Math.PI) / 180;
// Drawn smaller than the invisible hit-box it's solved to match (see
// drawRacquet) --- the full-size sprite dwarfed the court and its handle ran
// off the bottom of the arena.
const RACQUET_VISUAL_SCALE = 0.55;

function drawRacquetArt(art: CanvasRenderingContext2D, width: number, height: number) {
  const cx = width * HEAD_CENTER_X_FRAC;
  const cy = height * HEAD_CENTER_Y_FRAC;
  const rx = width * HEAD_RADIUS_X_FRAC;
  const ry = height * HEAD_RADIUS_Y_FRAC;
  const frameWidth = Math.min(rx, ry) * 0.3;
  const spacing = Math.min(rx, ry) * 0.24;

  art.clearRect(0, 0, width, height);

  // String bed, clipped to the inner ellipse.
  art.save();
  art.beginPath();
  art.ellipse(cx, cy, rx - frameWidth * 0.55, ry - frameWidth * 0.55, 0, 0, Math.PI * 2);
  art.clip();
  art.fillStyle = "#b7a4f0";
  art.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);

  // Diamond checker fill, computed in a 45deg-rotated local frame so it
  // doesn't need per-diamond trigonometry.
  art.save();
  art.translate(cx, cy);
  art.rotate(Math.PI / 4);
  for (let gx = -10; gx <= 10; gx++) {
    for (let gy = -10; gy <= 10; gy++) {
      if ((gx + gy) % 2 === 0) {
        art.fillStyle = "#f4f0ff";
        art.fillRect(gx * spacing, gy * spacing, spacing + 0.5, spacing + 0.5);
      }
    }
  }
  art.restore();

  art.fillStyle = "rgba(255, 255, 255, 0.4)";
  art.beginPath();
  art.ellipse(cx - rx * 0.32, cy - ry * 0.42, rx * 0.32, ry * 0.2, -0.4, 0, Math.PI * 2);
  art.fill();

  // Black diamond lattice, same rotated frame.
  art.save();
  art.translate(cx, cy);
  art.rotate(Math.PI / 4);
  art.strokeStyle = "#111318";
  art.lineWidth = Math.min(rx, ry) * 0.055;
  for (let x = -rx * 2; x <= rx * 2; x += spacing) {
    art.beginPath();
    art.moveTo(x, -ry * 2);
    art.lineTo(x, ry * 2);
    art.stroke();
  }
  for (let y = -ry * 2; y <= ry * 2; y += spacing) {
    art.beginPath();
    art.moveTo(-rx * 2, y);
    art.lineTo(rx * 2, y);
    art.stroke();
  }
  art.restore();
  art.restore(); // end bed clip

  // Frame ring, gradient shaded light-to-dark across the head.
  const gradient = art.createLinearGradient(cx - rx, cy - ry, cx + rx, cy + ry);
  gradient.addColorStop(0, "#ffcf7a");
  gradient.addColorStop(0.5, "#e2793a");
  gradient.addColorStop(1, "#7a2410");
  art.lineWidth = frameWidth;
  art.strokeStyle = gradient;
  art.beginPath();
  art.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  art.stroke();

  // Gloss highlight along the upper-left of the frame.
  art.beginPath();
  art.ellipse(cx, cy, rx - frameWidth * 0.1, ry - frameWidth * 0.1, 0, Math.PI, Math.PI * 1.5);
  art.strokeStyle = "rgba(255, 255, 255, 0.85)";
  art.lineWidth = frameWidth * 0.32;
  art.stroke();

  // Throat bridge connecting the head to the handle.
  const bridgeTopY = cy + ry * 0.86;
  const bridgeBottomY = cy + ry + height * 0.055;
  const bridgeTopHalfWidth = rx * 0.3;
  const handleHalfWidth = width * 0.062;
  art.fillStyle = "#f0c040";
  art.beginPath();
  art.moveTo(cx - bridgeTopHalfWidth, bridgeTopY);
  art.lineTo(cx + bridgeTopHalfWidth, bridgeTopY);
  art.lineTo(cx + handleHalfWidth, bridgeBottomY);
  art.lineTo(cx - handleHalfWidth, bridgeBottomY);
  art.closePath();
  art.fill();

  // Handle: two-tone shaft with navy grip bands at the collar and butt cap.
  const handleTop = bridgeBottomY;
  const handleBottom = height * 0.985;
  art.fillStyle = "#3fae7a";
  art.fillRect(cx - handleHalfWidth, handleTop, handleHalfWidth * 2, handleBottom - handleTop);
  art.fillStyle = "#7be3b0";
  art.fillRect(cx - handleHalfWidth, handleTop, handleHalfWidth, handleBottom - handleTop);
  const collarHeight = (handleBottom - handleTop) * 0.1;
  art.fillStyle = "#1e2a5e";
  art.fillRect(cx - handleHalfWidth - 2, handleTop, handleHalfWidth * 2 + 4, collarHeight);
  art.fillRect(cx - handleHalfWidth - 2, handleBottom - collarHeight, handleHalfWidth * 2 + 4, collarHeight);
}

// Built once at module load --- the art itself never changes, only how it's
// scaled and rotated onto the paddle each frame.
function createRacquetSprite(): HTMLCanvasElement {
  const artCanvas = document.createElement("canvas");
  artCanvas.width = ART_WIDTH;
  artCanvas.height = ART_HEIGHT;
  const artCtx = artCanvas.getContext("2d");
  if (artCtx) drawRacquetArt(artCtx, ART_WIDTH, ART_HEIGHT);

  const pixelHeight = Math.round((PIXEL_ART_WIDTH * ART_HEIGHT) / ART_WIDTH);
  const pixelCanvas = document.createElement("canvas");
  pixelCanvas.width = PIXEL_ART_WIDTH;
  pixelCanvas.height = pixelHeight;
  const pixelCtx = pixelCanvas.getContext("2d");
  if (pixelCtx) {
    pixelCtx.imageSmoothingEnabled = false;
    pixelCtx.drawImage(artCanvas, 0, 0, ART_WIDTH, ART_HEIGHT, 0, 0, PIXEL_ART_WIDTH, pixelHeight);
  }
  return pixelCanvas;
}

const racquetSprite = createRacquetSprite();
const RACQUET_HEAD_CENTER_X = racquetSprite.width * HEAD_CENTER_X_FRAC;
const RACQUET_HEAD_CENTER_Y = racquetSprite.height * HEAD_CENTER_Y_FRAC;
const RACQUET_HEAD_RADIUS_X = racquetSprite.width * HEAD_RADIUS_X_FRAC;
const RACQUET_HEAD_RADIUS_Y = racquetSprite.height * HEAD_RADIUS_Y_FRAC;

function drawRacquet(ctx: CanvasRenderingContext2D, paddle: { x: number; y: number; width: number }) {
  const projectedHalfWidth = Math.hypot(
    RACQUET_HEAD_RADIUS_X * Math.cos(TILT_ANGLE),
    RACQUET_HEAD_RADIUS_Y * Math.sin(TILT_ANGLE),
  );
  const scale = (paddle.width / (2 * projectedHalfWidth)) * RACQUET_VISUAL_SCALE;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(paddle.x, paddle.y);
  ctx.rotate(TILT_ANGLE);
  ctx.scale(scale, scale);
  ctx.drawImage(racquetSprite, -RACQUET_HEAD_CENTER_X, -RACQUET_HEAD_CENTER_Y);
  ctx.restore();
}

// Tennis-yellow ball with a couple of curved seam lines, a soft shadow for
// depth, and a brief squash-and-stretch on paddle contact (squashAmount goes
// 1 -> 0 over SQUASH_DURATION_MS after a hit).
const BALL_COLOR = "#d7e622";
const SEAM_COLOR = "rgba(255, 255, 255, 0.85)";
const SQUASH_STRETCH = 0.35;
export const SQUASH_DURATION_MS = 140;

function drawBall(ctx: CanvasRenderingContext2D, ball: { x: number; y: number; radius: number }, squashAmount: number) {
  const r = ball.radius;

  ctx.save();
  ctx.fillStyle = "rgba(15, 23, 42, 0.3)";
  ctx.beginPath();
  ctx.ellipse(ball.x, ball.y + r * 0.7, r * 0.9, r * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.scale(1 + squashAmount * SQUASH_STRETCH, 1 - squashAmount * SQUASH_STRETCH);

  ctx.beginPath();
  ctx.fillStyle = BALL_COLOR;
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = SEAM_COLOR;
  ctx.lineWidth = Math.max(1, r * 0.15);
  ctx.beginPath();
  ctx.moveTo(-r * 0.85, -r * 0.5);
  ctx.quadraticCurveTo(0, -r * 0.1, r * 0.85, -r * 0.5);
  ctx.moveTo(-r * 0.85, r * 0.5);
  ctx.quadraticCurveTo(0, r * 0.1, r * 0.85, r * 0.5);
  ctx.stroke();

  ctx.restore();
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
  let hitsSeen = 0;
  let squashTimer = 0;

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
      hitsSeen = 0;
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

    const squashAmount = squashTimer / SQUASH_DURATION_MS;
    drawRacquet(ctx, state.paddle);
    drawBall(ctx, state.ball, squashAmount);

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
      if (state.hits > hitsSeen) {
        hitsSeen = state.hits;
        squashTimer = SQUASH_DURATION_MS;
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

    squashTimer = Math.max(0, squashTimer - elapsed);

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
