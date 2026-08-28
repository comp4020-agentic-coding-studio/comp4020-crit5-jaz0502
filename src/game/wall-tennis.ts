// Pure game logic for wall tennis --- no DOM, no canvas, no window. Everything
// here is a plain function of state, so it's what spec/wall-tennis.test.ts
// exercises directly. Rendering, input and the game loop live in
// wall-tennis-view.ts instead, where they can be playtested but not unit
// tested.
//
// The arena's height is fixed, but its width isn't: the view picks a width
// that matches the actual screen's aspect ratio, so the game fills a laptop
// screen edge to edge instead of sitting in a phone-shaped column in the
// middle of it. Everything vertical (speeds, the paddle's line) is tuned
// against ARENA_HEIGHT; everything horizontal is proportional to whatever
// arenaWidth the caller passes in, so the game stays equally hard regardless
// of aspect ratio.

export const ARENA_HEIGHT = 800;

const PADDLE_WIDTH_RATIO = 45 / 480; // paddle covers this fraction of the arena's width
// Shrinks a little on every successful hit, same idea as the speed ramp below
// --- mirrors SPEED_GAIN_PER_HIT so the paddle keeps pace with the ball
// getting faster, rather than staying a constant-width target forever. Floored
// at a fraction of its starting width so a long rally doesn't shrink it to
// something unhittable.
const PADDLE_SHRINK_PER_HIT = 0.985;
const MIN_PADDLE_WIDTH_RATIO = PADDLE_WIDTH_RATIO * 0.45;
const PADDLE_HEIGHT = 14;
// Kept well clear of the bottom edge --- the racquet sprite drawn at this
// line (see wall-tennis-view.ts) is tilted and tall (a full handle below the
// head), so it needs real headroom below the paddle line or its handle runs
// off the bottom of the canvas.
export const PADDLE_Y = ARENA_HEIGHT - 220;
const BALL_RADIUS = 8;
const BASE_SPEED = 380; // px/s
const SPEED_GAIN_PER_HIT = 1.07;
const MAX_SPEED = BASE_SPEED * 2;
const MAX_BOUNCE_ANGLE = (60 * Math.PI) / 180; // radians off vertical, at the paddle's edge

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

export interface Paddle {
  x: number; // center x
  y: number; // fixed near the bottom edge
  width: number;
  height: number;
}

export type GameStatus = "playing" | "lost";

export interface GameState {
  ball: Ball;
  paddle: Paddle;
  status: GameStatus;
  hits: number;
}

export interface StepConfig {
  speedGainPerHit?: number;
  maxSpeed?: number;
  maxBounceAngle?: number;
}

// Static blocks the ball can bounce off, sitting between the top wall and
// the paddle's row so they're something to deflect around rather than a wall
// that blocks a straight shot. Derived from arenaWidth rather than stored in
// GameState, same reasoning as paddleWidthForHits: always an exact function
// of its input, no drift, nothing to reset on a new game.
const OBSTACLE_HEIGHT = 14;
const OBSTACLE_ROW_Y = ARENA_HEIGHT * 0.62;
const OBSTACLE_BLOCK_WIDTH_RATIO = 0.22; // of arenaWidth, each block
const OBSTACLE_GAP_RATIO = 0.3; // of arenaWidth, the gap between the two blocks

export interface Obstacle {
  x: number; // center x
  y: number; // center y
  width: number;
  height: number;
}

export function obstaclesForArena(arenaWidth: number): Obstacle[] {
  const blockWidth = arenaWidth * OBSTACLE_BLOCK_WIDTH_RATIO;
  const gap = arenaWidth * OBSTACLE_GAP_RATIO;
  const totalWidth = blockWidth * 2 + gap;
  const leftEdge = (arenaWidth - totalWidth) / 2;

  return [
    { x: leftEdge + blockWidth / 2, y: OBSTACLE_ROW_Y, width: blockWidth, height: OBSTACLE_HEIGHT },
    { x: leftEdge + blockWidth + gap + blockWidth / 2, y: OBSTACLE_ROW_Y, width: blockWidth, height: OBSTACLE_HEIGHT },
  ];
}

// Closest-point-on-AABB collision: find the nearest point on the obstacle's
// box to the ball's center, and treat the vector between them as the contact
// normal. Reflects velocity about that normal (v - 2*(v.n)*n). A side hit's
// normal is purely horizontal and a top/bottom hit's is purely vertical, so
// side hits only ever flip vx and top/bottom hits only ever flip vy --- the
// ball's vertical progress toward the paddle line is never undone by a side
// bounce, so it can't get stuck oscillating between two blocks.
export function resolveObstacleCollision(ball: Ball, obstacle: Obstacle): Ball | null {
  const left = obstacle.x - obstacle.width / 2;
  const right = obstacle.x + obstacle.width / 2;
  const top = obstacle.y - obstacle.height / 2;
  const bottom = obstacle.y + obstacle.height / 2;

  const closestX = Math.max(left, Math.min(ball.x, right));
  const closestY = Math.max(top, Math.min(ball.y, bottom));
  const dx = ball.x - closestX;
  const dy = ball.y - closestY;
  const distSq = dx * dx + dy * dy;
  if (distSq > ball.radius * ball.radius) return null;

  let nx: number;
  let ny: number;
  if (dx === 0 && dy === 0) {
    // The ball's center is already inside the box (deep tunneling in a
    // single step) --- there's no nearest-edge direction, so fall back to
    // pushing out along whichever axis has the smaller overlap.
    const overlapX = Math.min(ball.x - left, right - ball.x);
    const overlapY = Math.min(ball.y - top, bottom - ball.y);
    if (overlapX < overlapY) {
      nx = ball.x < obstacle.x ? -1 : 1;
      ny = 0;
    } else {
      nx = 0;
      ny = ball.y < obstacle.y ? -1 : 1;
    }
  } else {
    const dist = Math.sqrt(distSq);
    nx = dx / dist;
    ny = dy / dist;
  }

  const dot = ball.vx * nx + ball.vy * ny;
  return {
    ...ball,
    x: closestX + nx * ball.radius,
    y: closestY + ny * ball.radius,
    vx: ball.vx - 2 * dot * nx,
    vy: ball.vy - 2 * dot * ny,
  };
}

// Recomputed from scratch every frame (see step() below) rather than shrunk
// incrementally, so it's always an exact function of hits --- no drift, and
// no need to carry a running width in GameState.
function paddleWidthForHits(arenaWidth: number, hits: number): number {
  const ratio = Math.max(PADDLE_WIDTH_RATIO * Math.pow(PADDLE_SHRINK_PER_HIT, hits), MIN_PADDLE_WIDTH_RATIO);
  return arenaWidth * ratio;
}

export function createInitialState(arenaWidth: number, paddleCenterX: number = arenaWidth / 2): GameState {
  const paddle: Paddle = {
    x: paddleCenterX,
    y: PADDLE_Y,
    width: paddleWidthForHits(arenaWidth, 0),
    height: PADDLE_HEIGHT,
  };
  return {
    paddle,
    ball: {
      x: paddle.x,
      y: paddle.y - PADDLE_HEIGHT / 2 - BALL_RADIUS,
      vx: 0,
      vy: -BASE_SPEED,
      radius: BALL_RADIUS,
    },
    status: "playing",
    hits: 0,
  };
}

// The one rule the spec calls out for a focused automated test: a ball that
// reaches the paddle's line without the paddle underneath it is a wrong
// move, and the round is over. Shares its threshold with the hit check in
// step() below, so a given position is always exactly one of hit or missed.
export function hasMissedPaddle(ball: Ball, paddle: Paddle, arenaHeight: number): boolean {
  const reachedPaddleLine = ball.y + ball.radius >= paddle.y - paddle.height / 2;
  if (!reachedPaddleLine) return false;
  const withinPaddle = Math.abs(ball.x - paddle.x) <= paddle.width / 2 + ball.radius;
  return !withinPaddle || ball.y - ball.radius >= arenaHeight;
}

// Bounce angle depends on where the ball lands on the paddle: dead center
// sends it straight up, the edges send it off at up to maxBounceAngle. That's
// the aiming skill that makes the game harder to master than "always bounces
// straight back."
export function reflectOffPaddle(ball: Ball, paddle: Paddle, config: StepConfig = {}): Ball {
  const maxBounceAngle = config.maxBounceAngle ?? MAX_BOUNCE_ANGLE;
  const speed = Math.hypot(ball.vx, ball.vy);
  const offset = Math.max(-1, Math.min(1, (ball.x - paddle.x) / (paddle.width / 2)));
  const angle = offset * maxBounceAngle;
  return {
    ...ball,
    y: paddle.y - paddle.height / 2 - ball.radius,
    vx: speed * Math.sin(angle),
    vy: -Math.abs(speed * Math.cos(angle)),
  };
}

function withWallBounces(ball: Ball, arenaWidth: number): Ball {
  let { x, vx } = ball;
  if (x - ball.radius < 0) {
    x = ball.radius;
    vx = Math.abs(vx);
  } else if (x + ball.radius > arenaWidth) {
    x = arenaWidth - ball.radius;
    vx = -Math.abs(vx);
  }
  let { y, vy } = { y: ball.y, vy: ball.vy };
  if (y - ball.radius < 0) {
    y = ball.radius;
    vy = Math.abs(vy);
  }
  return { ...ball, x, y, vx, vy };
}

export function step(
  state: GameState,
  dtMs: number,
  paddleCenterX: number,
  arenaWidth: number,
  config: StepConfig = {},
): GameState {
  if (state.status === "lost") return state;

  const speedGainPerHit = config.speedGainPerHit ?? SPEED_GAIN_PER_HIT;
  const maxSpeed = config.maxSpeed ?? MAX_SPEED;
  const dt = dtMs / 1000;

  const paddle: Paddle = { ...state.paddle, x: paddleCenterX, width: paddleWidthForHits(arenaWidth, state.hits) };
  const moved: Ball = {
    ...state.ball,
    x: state.ball.x + state.ball.vx * dt,
    y: state.ball.y + state.ball.vy * dt,
  };
  const bounced = withWallBounces(moved, arenaWidth);

  let deflected = bounced;
  for (const obstacle of obstaclesForArena(arenaWidth)) {
    const resolved = resolveObstacleCollision(deflected, obstacle);
    if (resolved) {
      deflected = resolved;
      break;
    }
  }

  if (hasMissedPaddle(deflected, paddle, ARENA_HEIGHT)) {
    return { ...state, ball: deflected, paddle, status: "lost" };
  }

  const hitPaddle = deflected.vy > 0 && deflected.y + deflected.radius >= paddle.y - paddle.height / 2;
  if (hitPaddle) {
    const speed = Math.min(Math.hypot(deflected.vx, deflected.vy) * speedGainPerHit, maxSpeed);
    const reflected = reflectOffPaddle({ ...deflected, vx: 0, vy: -speed }, paddle, config);
    return { ...state, ball: reflected, paddle, status: "playing", hits: state.hits + 1 };
  }

  return { ...state, ball: deflected, paddle };
}
