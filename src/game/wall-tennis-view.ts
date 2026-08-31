// Rendering, input and the game loop for wall tennis. Everything here touches
// the DOM or the canvas, so none of it is unit tested --- it's playtested by
// hand instead. Physics and rules live in wall-tennis.ts.

import {
  ARENA_HEIGHT,
  PADDLE_Y,
  createInitialState,
  obstaclesForArena,
  step,
  stepConfigForDifficulty,
  type Difficulty,
  type GameState,
  type Obstacle,
  type Target,
} from "./wall-tennis";

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

// Static court obstacles: flat bezel-style blocks matching the plaques used
// elsewhere in this view, so they read as part of the same UI language
// rather than a bolted-on extra.
const OBSTACLE_FILL = "#8a8f9c";
const OBSTACLE_BORDER = "#3d4150";
const OBSTACLE_BORDER_WIDTH = 3;

function drawObstacle(ctx: CanvasRenderingContext2D, obstacle: Obstacle) {
  const x = obstacle.x - obstacle.width / 2;
  const y = obstacle.y - obstacle.height / 2;

  ctx.fillStyle = OBSTACLE_BORDER;
  ctx.fillRect(
    x - OBSTACLE_BORDER_WIDTH,
    y - OBSTACLE_BORDER_WIDTH,
    obstacle.width + OBSTACLE_BORDER_WIDTH * 2,
    obstacle.height + OBSTACLE_BORDER_WIDTH * 2,
  );
  ctx.fillStyle = OBSTACLE_FILL;
  ctx.fillRect(x, y, obstacle.width, obstacle.height);
}

function drawObstacles(ctx: CanvasRenderingContext2D, arenaWidth: number, elapsedMs: number) {
  for (const obstacle of obstaclesForArena(arenaWidth, elapsedMs)) drawObstacle(ctx, obstacle);
}

// Bonus target: a red/white bullseye with its point value stamped in the
// middle, so its worth is legible at a glance without a separate legend ---
// smaller rings mean fewer, more concentrated rings so the "harder shot,
// bigger reward" reads visually too.
const TARGET_RING_COLORS = ["#e63946", "#f1faee", "#e63946"];
const TARGET_LABEL_COLOR = "#f1faee";
const TARGET_LABEL_OUTLINE = "#1e2a5e";

function drawTarget(ctx: CanvasRenderingContext2D, target: Target) {
  const rings = TARGET_RING_COLORS.length;
  for (let i = rings; i >= 1; i--) {
    ctx.beginPath();
    ctx.arc(target.x, target.y, (target.radius * i) / rings, 0, Math.PI * 2);
    ctx.fillStyle = TARGET_RING_COLORS[rings - i];
    ctx.fill();
  }

  ctx.font = `bold ${Math.round(target.radius)}px 'Courier New', monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const label = `${target.points}`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = TARGET_LABEL_OUTLINE;
  ctx.strokeText(label, target.x, target.y);
  ctx.fillStyle = TARGET_LABEL_COLOR;
  ctx.fillText(label, target.x, target.y);
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

// Retro 7-segment scoreboard, gold-bezelled plaque to match the racquet's
// frame colours. Unlit segments are drawn as a faint ghost of the on colour
// --- the standard real-LED-display look --- instead of just leaving a gap,
// so every digit reads as a digit even when most of its segments are off.
const SCORE_DIGIT_WIDTH = 22;
const SCORE_DIGIT_HEIGHT = 34;
const SCORE_DIGIT_GAP = 8;
const SCORE_SEGMENT_THICKNESS_RATIO = 0.22; // of digit width
const SCORE_SEGMENT_GAP = 1.5; // shrinks each bar slightly so adjoining segments read as separate
const SCORE_PANEL_PADDING_X = 14;
const SCORE_PANEL_PADDING_Y = 10;
const SCORE_PANEL_MARGIN = 16; // gap from the top and right edges of the arena
const SCORE_PANEL_BORDER = 4;
const SCORE_ON_COLOR = "#ff5a36";
const SCORE_OFF_COLOR = "rgba(255, 90, 54, 0.14)";
const SCORE_PANEL_BG = "#12141c";
const SCORE_PANEL_BEZEL = "#f0c040";
const SCORE_LABEL_TEXT = "SCORE:";
const SCORE_LABEL_FONT = "bold 16px 'Courier New', monospace";
const SCORE_LABEL_GAP = 10; // between the label and the first digit

// Which of the seven segments (a: top, b: top-right, c: bottom-right,
// d: bottom, e: bottom-left, f: top-left, g: middle) are lit for each digit.
const DIGIT_SEGMENTS: readonly (readonly boolean[])[] = [
  [true, true, true, true, true, true, false], // 0
  [false, true, true, false, false, false, false], // 1
  [true, true, false, true, true, false, true], // 2
  [true, true, true, true, false, false, true], // 3
  [false, true, true, false, false, true, true], // 4
  [true, false, true, true, false, true, true], // 5
  [true, false, true, true, true, true, true], // 6
  [true, true, true, false, false, false, false], // 7
  [true, true, true, true, true, true, true], // 8
  [true, true, true, true, false, true, true], // 9
];

function drawSevenSegmentDigit(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, digit: number) {
  const segments = DIGIT_SEGMENTS[digit];
  const t = w * SCORE_SEGMENT_THICKNESS_RATIO;
  const halfH = (h - 3 * t) / 2;
  const gap = SCORE_SEGMENT_GAP;

  const bar = (sx: number, sy: number, sw: number, sh: number, lit: boolean) => {
    ctx.fillStyle = lit ? SCORE_ON_COLOR : SCORE_OFF_COLOR;
    ctx.fillRect(x + sx, y + sy, sw, sh);
  };

  bar(t + gap, 0, w - 2 * t - 2 * gap, t, segments[0]); // a
  bar(w - t, t + gap, t, halfH - 2 * gap, segments[1]); // b
  bar(w - t, t + halfH + t + gap, t, halfH - 2 * gap, segments[2]); // c
  bar(t + gap, h - t, w - 2 * t - 2 * gap, t, segments[3]); // d
  bar(0, t + halfH + t + gap, t, halfH - 2 * gap, segments[4]); // e
  bar(0, t + gap, t, halfH - 2 * gap, segments[5]); // f
  bar(t + gap, t + halfH, w - 2 * t - 2 * gap, t, segments[6]); // g
}

function drawScoreboard(ctx: CanvasRenderingContext2D, arenaWidth: number, score: number) {
  const digits = String(score).split("").map(Number);
  const digitsWidth = digits.length * SCORE_DIGIT_WIDTH + (digits.length - 1) * SCORE_DIGIT_GAP;

  ctx.font = SCORE_LABEL_FONT;
  const labelWidth = ctx.measureText(SCORE_LABEL_TEXT).width;

  const contentWidth = labelWidth + SCORE_LABEL_GAP + digitsWidth;
  const panelWidth = contentWidth + SCORE_PANEL_PADDING_X * 2;
  const panelHeight = SCORE_DIGIT_HEIGHT + SCORE_PANEL_PADDING_Y * 2;
  const panelX = arenaWidth - panelWidth - SCORE_PANEL_MARGIN;
  const panelY = SCORE_PANEL_MARGIN;

  ctx.fillStyle = SCORE_PANEL_BEZEL;
  ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
  ctx.fillStyle = SCORE_PANEL_BG;
  ctx.fillRect(
    panelX + SCORE_PANEL_BORDER,
    panelY + SCORE_PANEL_BORDER,
    panelWidth - SCORE_PANEL_BORDER * 2,
    panelHeight - SCORE_PANEL_BORDER * 2,
  );

  const labelX = panelX + SCORE_PANEL_PADDING_X;
  ctx.font = SCORE_LABEL_FONT;
  ctx.fillStyle = SCORE_PANEL_BEZEL;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(SCORE_LABEL_TEXT, labelX, panelY + panelHeight / 2);

  const digitsStartX = labelX + labelWidth + SCORE_LABEL_GAP;
  const digitsY = panelY + SCORE_PANEL_PADDING_Y;
  digits.forEach((digit, i) => {
    const dx = digitsStartX + i * (SCORE_DIGIT_WIDTH + SCORE_DIGIT_GAP);
    drawSevenSegmentDigit(ctx, dx, digitsY, SCORE_DIGIT_WIDTH, SCORE_DIGIT_HEIGHT, digit);
  });
}

// Game-over overlay: a dark plaque (same bezel styling as the scoreboard),
// centered in the arena, shown for as long as state.status is "lost".
const GAME_OVER_TITLE = "GAME OVER";
const GAME_OVER_TITLE_FONT = "bold 48px 'Courier New', monospace";
const GAME_OVER_SUBTITLE_FONT = "bold 22px 'Courier New', monospace";
const GAME_OVER_TITLE_SIZE = 48;
const GAME_OVER_SUBTITLE_SIZE = 22;
const GAME_OVER_LINE_GAP = 14;
const GAME_OVER_PANEL_PADDING_X = 40;
const GAME_OVER_PANEL_PADDING_Y = 28;
const GAME_OVER_TEXT_COLOR = "#f8fafc";

// "New game" button, sitting under the final score inside the same plaque.
// Drawn on the canvas rather than as a real DOM element --- everything else
// in this view is canvas-drawn, so the click is hit-tested against the
// bounds this function hands back (see startWallTennis's pointer handler)
// instead of relying on the DOM's own hit-testing.
const NEW_GAME_BUTTON_TEXT = "NEW GAME";
const NEW_GAME_BUTTON_FONT = "bold 22px 'Courier New', monospace";
const NEW_GAME_BUTTON_FONT_SIZE = 22;
const NEW_GAME_BUTTON_PADDING_X = 28;
const NEW_GAME_BUTTON_PADDING_Y = 14;
const NEW_GAME_BUTTON_GAP = 24; // above the button, below the final-score line
const NEW_GAME_BUTTON_BORDER = 3;
const NEW_GAME_BUTTON_BG = "#3fae7a"; // matches the racquet handle's green
const NEW_GAME_BUTTON_BORDER_COLOR = "#1e2a5e"; // matches the handle's navy collar bands
const NEW_GAME_BUTTON_TEXT_COLOR = "#0b1220";

export interface ButtonBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function drawGameOverOverlay(ctx: CanvasRenderingContext2D, arenaWidth: number, score: number): ButtonBounds {
  const centerX = arenaWidth / 2;
  const centerY = ARENA_HEIGHT / 2;
  const subtitleText = `Final score: ${score}`;

  ctx.font = GAME_OVER_TITLE_FONT;
  const titleWidth = ctx.measureText(GAME_OVER_TITLE).width;
  ctx.font = GAME_OVER_SUBTITLE_FONT;
  const subtitleWidth = ctx.measureText(subtitleText).width;
  ctx.font = NEW_GAME_BUTTON_FONT;
  const buttonWidth = ctx.measureText(NEW_GAME_BUTTON_TEXT).width + NEW_GAME_BUTTON_PADDING_X * 2;
  const buttonHeight = NEW_GAME_BUTTON_FONT_SIZE + NEW_GAME_BUTTON_PADDING_Y * 2;

  const panelWidth = Math.max(titleWidth, subtitleWidth, buttonWidth) + GAME_OVER_PANEL_PADDING_X * 2;
  const panelHeight =
    GAME_OVER_TITLE_SIZE +
    GAME_OVER_LINE_GAP +
    GAME_OVER_SUBTITLE_SIZE +
    NEW_GAME_BUTTON_GAP +
    buttonHeight +
    GAME_OVER_PANEL_PADDING_Y * 2;
  const panelX = centerX - panelWidth / 2;
  const panelY = centerY - panelHeight / 2;

  ctx.fillStyle = SCORE_PANEL_BEZEL;
  ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
  ctx.fillStyle = SCORE_PANEL_BG;
  ctx.fillRect(
    panelX + SCORE_PANEL_BORDER,
    panelY + SCORE_PANEL_BORDER,
    panelWidth - SCORE_PANEL_BORDER * 2,
    panelHeight - SCORE_PANEL_BORDER * 2,
  );

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = GAME_OVER_TITLE_FONT;
  ctx.fillStyle = GAME_OVER_TEXT_COLOR;
  ctx.fillText(GAME_OVER_TITLE, centerX, panelY + GAME_OVER_PANEL_PADDING_Y + GAME_OVER_TITLE_SIZE / 2);

  const subtitleY = panelY + GAME_OVER_PANEL_PADDING_Y + GAME_OVER_TITLE_SIZE + GAME_OVER_LINE_GAP + GAME_OVER_SUBTITLE_SIZE / 2;
  ctx.font = GAME_OVER_SUBTITLE_FONT;
  ctx.fillStyle = SCORE_ON_COLOR;
  ctx.fillText(subtitleText, centerX, subtitleY);

  const buttonX = centerX - buttonWidth / 2;
  const buttonY = subtitleY + GAME_OVER_SUBTITLE_SIZE / 2 + NEW_GAME_BUTTON_GAP;

  ctx.fillStyle = NEW_GAME_BUTTON_BORDER_COLOR;
  ctx.fillRect(
    buttonX - NEW_GAME_BUTTON_BORDER,
    buttonY - NEW_GAME_BUTTON_BORDER,
    buttonWidth + NEW_GAME_BUTTON_BORDER * 2,
    buttonHeight + NEW_GAME_BUTTON_BORDER * 2,
  );
  ctx.fillStyle = NEW_GAME_BUTTON_BG;
  ctx.fillRect(buttonX, buttonY, buttonWidth, buttonHeight);

  ctx.font = NEW_GAME_BUTTON_FONT;
  ctx.fillStyle = NEW_GAME_BUTTON_TEXT_COLOR;
  ctx.fillText(NEW_GAME_BUTTON_TEXT, centerX, buttonY + buttonHeight / 2);

  return { x: buttonX, y: buttonY, width: buttonWidth, height: buttonHeight };
}

function isInsideBounds(x: number, y: number, bounds: ButtonBounds): boolean {
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}

// Difficulty picker: same plaque styling as the game-over overlay, shown
// before the very first round and again after "New game" so the player can
// change difficulty each round. Colour-coded green/gold/red so the ramp in
// difficulty reads at a glance, same language as the target bullseye's red.
const DIFFICULTY_TITLE = "SELECT DIFFICULTY";
const DIFFICULTY_TITLE_FONT = "bold 30px 'Courier New', monospace";
const DIFFICULTY_TITLE_SIZE = 30;
const DIFFICULTY_BUTTON_FONT = "bold 20px 'Courier New', monospace";
const DIFFICULTY_BUTTON_FONT_SIZE = 20;
const DIFFICULTY_BUTTON_PADDING_X = 22;
const DIFFICULTY_BUTTON_PADDING_Y = 14;
const DIFFICULTY_BUTTON_GAP = 18;
const DIFFICULTY_BUTTON_BORDER = 3;
const DIFFICULTY_BUTTON_BORDER_COLOR = "#1e2a5e"; // matches the game-over button's navy collar bands
const DIFFICULTY_BUTTON_TEXT_COLOR = "#0b1220";
const DIFFICULTY_OPTIONS: { difficulty: Difficulty; label: string; color: string }[] = [
  { difficulty: "easy", label: "EASY", color: "#3fae7a" },
  { difficulty: "medium", label: "MEDIUM", color: "#f0c040" },
  { difficulty: "hard", label: "HARD", color: "#e63946" },
];

function drawDifficultySelect(ctx: CanvasRenderingContext2D, arenaWidth: number): Record<Difficulty, ButtonBounds> {
  const centerX = arenaWidth / 2;
  const centerY = ARENA_HEIGHT / 2;

  ctx.font = DIFFICULTY_BUTTON_FONT;
  const buttonHeight = DIFFICULTY_BUTTON_FONT_SIZE + DIFFICULTY_BUTTON_PADDING_Y * 2;
  const buttonWidths = DIFFICULTY_OPTIONS.map((option) => ctx.measureText(option.label).width + DIFFICULTY_BUTTON_PADDING_X * 2);
  const buttonsWidth = buttonWidths.reduce((total, width) => total + width, 0) + DIFFICULTY_BUTTON_GAP * (DIFFICULTY_OPTIONS.length - 1);

  ctx.font = DIFFICULTY_TITLE_FONT;
  const titleWidth = ctx.measureText(DIFFICULTY_TITLE).width;

  const panelWidth = Math.max(titleWidth, buttonsWidth) + GAME_OVER_PANEL_PADDING_X * 2;
  const panelHeight = DIFFICULTY_TITLE_SIZE + DIFFICULTY_BUTTON_GAP + buttonHeight + GAME_OVER_PANEL_PADDING_Y * 2;
  const panelX = centerX - panelWidth / 2;
  const panelY = centerY - panelHeight / 2;

  ctx.fillStyle = SCORE_PANEL_BEZEL;
  ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
  ctx.fillStyle = SCORE_PANEL_BG;
  ctx.fillRect(
    panelX + SCORE_PANEL_BORDER,
    panelY + SCORE_PANEL_BORDER,
    panelWidth - SCORE_PANEL_BORDER * 2,
    panelHeight - SCORE_PANEL_BORDER * 2,
  );

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = DIFFICULTY_TITLE_FONT;
  ctx.fillStyle = GAME_OVER_TEXT_COLOR;
  ctx.fillText(DIFFICULTY_TITLE, centerX, panelY + GAME_OVER_PANEL_PADDING_Y + DIFFICULTY_TITLE_SIZE / 2);

  const buttonY = panelY + GAME_OVER_PANEL_PADDING_Y + DIFFICULTY_TITLE_SIZE + DIFFICULTY_BUTTON_GAP;
  let buttonX = centerX - buttonsWidth / 2;
  const bounds = {} as Record<Difficulty, ButtonBounds>;

  ctx.font = DIFFICULTY_BUTTON_FONT;
  DIFFICULTY_OPTIONS.forEach((option, i) => {
    const width = buttonWidths[i];
    ctx.fillStyle = DIFFICULTY_BUTTON_BORDER_COLOR;
    ctx.fillRect(
      buttonX - DIFFICULTY_BUTTON_BORDER,
      buttonY - DIFFICULTY_BUTTON_BORDER,
      width + DIFFICULTY_BUTTON_BORDER * 2,
      buttonHeight + DIFFICULTY_BUTTON_BORDER * 2,
    );
    ctx.fillStyle = option.color;
    ctx.fillRect(buttonX, buttonY, width, buttonHeight);
    ctx.fillStyle = DIFFICULTY_BUTTON_TEXT_COLOR;
    ctx.fillText(option.label, buttonX + width / 2, buttonY + buttonHeight / 2);

    bounds[option.difficulty] = { x: buttonX, y: buttonY, width, height: buttonHeight };
    buttonX += width + DIFFICULTY_BUTTON_GAP;
  });

  return bounds;
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
  let newGameButtonBounds: ButtonBounds | null = null;
  let difficulty: Difficulty | null = null;
  let difficultyButtonBounds: Record<Difficulty, ButtonBounds> | null = null;

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

  function toArenaY(clientY: number): number {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const { scale } = arenaTransform();
    return ((clientY - rect.top) * dpr) / scale;
  }

  resize();
  let state: GameState = createInitialState(arenaTransform().arenaWidth);
  pointerX = state.paddle.x;

  // No difficulty chosen yet: the game sits frozen and dimmed behind the
  // difficulty plaque until the player picks easy/medium/hard. While the
  // round is lost, the ball's frozen and the paddle no longer follows the
  // pointer --- the only way back is clicking "New game", which returns to
  // the difficulty plaque so the player can pick again each round.
  function onPointer(event: PointerEvent) {
    const { arenaWidth } = arenaTransform();
    const arenaX = Math.max(0, Math.min(arenaWidth, toArenaX(event.clientX)));

    if (difficulty === null) {
      const arenaY = toArenaY(event.clientY);
      const hovered = difficultyButtonBounds
        ? (Object.entries(difficultyButtonBounds) as [Difficulty, ButtonBounds][]).find(([, bounds]) =>
            isInsideBounds(arenaX, arenaY, bounds),
          )
        : undefined;
      canvas.style.cursor = hovered ? "pointer" : "default";
      if (event.type === "pointerdown" && hovered) {
        difficulty = hovered[0];
        // Always re-center horizontally --- the ball (and the paddle under
        // it) start from the arena's midpoint, not wherever the player
        // happened to click the button.
        state = createInitialState(arenaWidth);
        pointerX = state.paddle.x;
        hitsSeen = 0;
        launched = false;
      }
      return;
    }

    if (state.status === "lost") {
      const arenaY = toArenaY(event.clientY);
      const overButton = newGameButtonBounds !== null && isInsideBounds(arenaX, arenaY, newGameButtonBounds);
      canvas.style.cursor = overButton ? "pointer" : "default";
      if (event.type === "pointerdown" && overButton) {
        difficulty = null;
      }
      return;
    }

    canvas.style.cursor = "default";
    pointerX = arenaX;
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

    ctx.globalAlpha = difficulty === null || state.status === "lost" ? 0.4 : 1;

    const obstaclesEnabled = difficulty !== null && (stepConfigForDifficulty(difficulty).obstaclesEnabled ?? true);
    if (obstaclesEnabled) drawObstacles(ctx, arenaWidth, state.elapsedMs);
    if (state.target) drawTarget(ctx, state.target);

    const squashAmount = squashTimer / SQUASH_DURATION_MS;
    drawRacquet(ctx, state.paddle);
    drawBall(ctx, state.ball, squashAmount);

    ctx.globalAlpha = 1;
    drawScoreboard(ctx, arenaWidth, state.score);

    if (difficulty === null) {
      difficultyButtonBounds = drawDifficultySelect(ctx, arenaWidth);
      newGameButtonBounds = null;
    } else if (state.status === "lost") {
      newGameButtonBounds = drawGameOverOverlay(ctx, arenaWidth, state.score);
      difficultyButtonBounds = null;
    } else {
      newGameButtonBounds = null;
      difficultyButtonBounds = null;
    }

    ctx.restore();
  }

  function frame(time: number) {
    if (!lastTime) lastTime = time;
    const elapsed = Math.min(time - lastTime, MAX_FRAME_MS);
    lastTime = time;

    const { scale, arenaWidth } = arenaTransform();

    if (difficulty !== null && state.status === "playing" && launched) {
      const stepConfig = stepConfigForDifficulty(difficulty);
      accumulator += elapsed;
      while (accumulator >= FIXED_DT_MS) {
        state = step(state, FIXED_DT_MS, pointerX, arenaWidth, stepConfig);
        accumulator -= FIXED_DT_MS;
      }
      if (state.hits > hitsSeen) {
        hitsSeen = state.hits;
        squashTimer = SQUASH_DURATION_MS;
      }
    } else if (difficulty !== null && state.status === "playing") {
      // Not launched yet: the ball rides the paddle so the opening frame
      // reads as "aim, then go" with no caption needed.
      const paddle = { ...state.paddle, x: pointerX };
      state = {
        ...state,
        paddle,
        ball: { ...state.ball, x: pointerX, y: paddle.y - paddle.height / 2 - state.ball.radius },
        elapsedMs: state.elapsedMs + elapsed,
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
