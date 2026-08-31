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
const SPEED_GAIN_PER_HIT = 1.04;
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

// A bonus target the ball can pass through for extra score, on top of the
// paddle-rally point it already earns hitting the ball back. Independent of
// hits/paddleWidthForHits --- rally length still drives the difficulty ramp,
// targets are a separate side objective that just adds to score.
export interface Target {
  x: number; // center x
  y: number; // center y
  radius: number;
  points: number;
  expiresAtMs: number; // elapsedMs at which it vanishes if not hit
}

export interface GameState {
  ball: Ball;
  paddle: Paddle;
  status: GameStatus;
  hits: number;
  elapsedMs: number;
  score: number;
  target: Target | null;
  nextTargetAtMs: number; // elapsedMs at which the next target may spawn
}

export interface StepConfig {
  speedGainPerHit?: number;
  maxSpeed?: number;
  maxBounceAngle?: number;
  rng?: () => number; // injectable for deterministic tests; defaults to Math.random
  paddleShrinkPerHit?: number;
  obstaclesEnabled?: boolean;
}

export type Difficulty = "easy" | "medium" | "hard";

// Difficulty just picks which of the ramps StepConfig already exposes are
// switched on --- easy turns them all off, medium turns on obstacles and the
// paddle shrink but not the speed ramp, hard turns everything on. A lookup
// rather than scattered conditionals, so the view has one function to call
// when building each frame's StepConfig for the chosen difficulty.
export function stepConfigForDifficulty(difficulty: Difficulty): StepConfig {
  switch (difficulty) {
    case "easy":
      return { obstaclesEnabled: false, paddleShrinkPerHit: 1, speedGainPerHit: 1 };
    case "medium":
      return { obstaclesEnabled: true, paddleShrinkPerHit: PADDLE_SHRINK_PER_HIT, speedGainPerHit: 1 };
    case "hard":
      return { obstaclesEnabled: true, paddleShrinkPerHit: PADDLE_SHRINK_PER_HIT, speedGainPerHit: SPEED_GAIN_PER_HIT };
  }
}

// Static blocks the ball can bounce off, sitting between the top wall and
// the paddle's row so they're something to deflect around rather than a wall
// that blocks a straight shot. Derived from arenaWidth (and elapsedMs, for
// their side-to-side drift) rather than stored in GameState, same reasoning
// as paddleWidthForHits: always an exact function of its inputs, no drift to
// track, nothing to reset on a new game.
const OBSTACLE_HEIGHT = 14;
const OBSTACLE_ROW_Y = ARENA_HEIGHT * 0.62;
const OBSTACLE_BLOCK_WIDTH_RATIO = 0.22; // of arenaWidth, each block
const OBSTACLE_GAP_RATIO = 0.3; // of arenaWidth, the gap between the two blocks
// The pair drifts left and right together (gap between them stays fixed)
// rather than each block moving independently, so they can never drift into
// each other. Amplitude is clamped to the margin between the pair and the
// arena walls (see leftEdge below), so they can never drift off-screen either.
const OBSTACLE_MOVE_AMPLITUDE_RATIO = 0.12; // of arenaWidth, capped by the wall margin
const OBSTACLE_MOVE_PERIOD_MS = 4000; // one full left-right-left cycle

export interface Obstacle {
  x: number; // center x
  y: number; // center y
  width: number;
  height: number;
}

export function obstaclesForArena(arenaWidth: number, elapsedMs = 0): Obstacle[] {
  const blockWidth = arenaWidth * OBSTACLE_BLOCK_WIDTH_RATIO;
  const gap = arenaWidth * OBSTACLE_GAP_RATIO;
  const totalWidth = blockWidth * 2 + gap;
  const leftEdge = (arenaWidth - totalWidth) / 2;
  const amplitude = Math.min(leftEdge, arenaWidth * OBSTACLE_MOVE_AMPLITUDE_RATIO);
  const offset = amplitude * Math.sin((2 * Math.PI * elapsedMs) / OBSTACLE_MOVE_PERIOD_MS);

  return [
    { x: leftEdge + blockWidth / 2 + offset, y: OBSTACLE_ROW_Y, width: blockWidth, height: OBSTACLE_HEIGHT },
    { x: leftEdge + blockWidth + gap + blockWidth / 2 + offset, y: OBSTACLE_ROW_Y, width: blockWidth, height: OBSTACLE_HEIGHT },
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

// Bonus targets: appear one at a time, at random, for the ball to pass
// through. Smaller is worth more --- it's the harder shot to land. Unlike
// obstacles these DO live in GameState (position and size are randomised per
// spawn, not a pure function of arenaWidth), but nextTargetAtMs/expiresAtMs
// are plain elapsedMs deadlines rather than timers, so step() stays a pure
// function of its inputs and a fixed dt sequence always replays identically.
const TARGET_SMALL_RADIUS = 20;
const TARGET_SMALL_POINTS = 5;
const TARGET_LARGE_RADIUS = 30;
const TARGET_LARGE_POINTS = 3;
const TARGET_LIFETIME_MS = 3500; // vanishes if not hit within this long
const TARGET_SPAWN_GAP_MIN_MS = 3000; // gap after a target is hit or expires
const TARGET_SPAWN_GAP_MAX_MS = 6000;
const INITIAL_TARGET_DELAY_MS = 2500; // before the very first target of a round
const TARGET_X_MARGIN_RATIO = 0.18; // of arenaWidth, kept clear of the side walls
// Kept above the obstacle row so a target never spawns overlapping a block.
const TARGET_Y_MIN = ARENA_HEIGHT * 0.12;
const TARGET_Y_MAX = ARENA_HEIGHT * 0.48;

function spawnTarget(arenaWidth: number, elapsedMs: number, rng: () => number): Target {
  const isSmall = rng() < 0.5;
  const radius = isSmall ? TARGET_SMALL_RADIUS : TARGET_LARGE_RADIUS;
  const points = isSmall ? TARGET_SMALL_POINTS : TARGET_LARGE_POINTS;
  const margin = arenaWidth * TARGET_X_MARGIN_RATIO;
  const x = margin + rng() * Math.max(0, arenaWidth - margin * 2);
  const y = TARGET_Y_MIN + rng() * (TARGET_Y_MAX - TARGET_Y_MIN);
  return { x, y, radius, points, expiresAtMs: elapsedMs + TARGET_LIFETIME_MS };
}

function nextTargetGap(elapsedMs: number, rng: () => number): number {
  return elapsedMs + TARGET_SPAWN_GAP_MIN_MS + rng() * (TARGET_SPAWN_GAP_MAX_MS - TARGET_SPAWN_GAP_MIN_MS);
}

function ballHitsTarget(ball: Ball, target: Target): boolean {
  const dx = ball.x - target.x;
  const dy = ball.y - target.y;
  const reach = ball.radius + target.radius;
  return dx * dx + dy * dy <= reach * reach;
}

// Recomputed from scratch every frame (see step() below) rather than shrunk
// incrementally, so it's always an exact function of hits --- no drift, and
// no need to carry a running width in GameState. shrinkPerHit is 1 (no
// shrink at all) on easy, so a hits=0 paddle is the same size regardless.
function paddleWidthForHits(arenaWidth: number, hits: number, shrinkPerHit: number): number {
  const ratio = Math.max(PADDLE_WIDTH_RATIO * Math.pow(shrinkPerHit, hits), MIN_PADDLE_WIDTH_RATIO);
  return arenaWidth * ratio;
}

export function createInitialState(arenaWidth: number, paddleCenterX: number = arenaWidth / 2): GameState {
  const paddle: Paddle = {
    x: paddleCenterX,
    y: PADDLE_Y,
    width: paddleWidthForHits(arenaWidth, 0, PADDLE_SHRINK_PER_HIT),
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
    elapsedMs: 0,
    score: 0,
    target: null,
    nextTargetAtMs: INITIAL_TARGET_DELAY_MS,
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
  const rng = config.rng ?? Math.random;
  const paddleShrinkPerHit = config.paddleShrinkPerHit ?? PADDLE_SHRINK_PER_HIT;
  const obstaclesEnabled = config.obstaclesEnabled ?? true;
  const dt = dtMs / 1000;

  const elapsedMs = state.elapsedMs + dtMs;
  const paddle: Paddle = {
    ...state.paddle,
    x: paddleCenterX,
    width: paddleWidthForHits(arenaWidth, state.hits, paddleShrinkPerHit),
  };
  const moved: Ball = {
    ...state.ball,
    x: state.ball.x + state.ball.vx * dt,
    y: state.ball.y + state.ball.vy * dt,
  };
  const bounced = withWallBounces(moved, arenaWidth);

  let deflected = bounced;
  if (obstaclesEnabled) {
    for (const obstacle of obstaclesForArena(arenaWidth, elapsedMs)) {
      const resolved = resolveObstacleCollision(deflected, obstacle);
      if (resolved) {
        deflected = resolved;
        break;
      }
    }
  }

  let target = state.target;
  let nextTargetAtMs = state.nextTargetAtMs;
  let score = state.score;
  if (target && ballHitsTarget(deflected, target)) {
    score += target.points;
    target = null;
    nextTargetAtMs = nextTargetGap(elapsedMs, rng);
  } else if (target && elapsedMs >= target.expiresAtMs) {
    target = null;
    nextTargetAtMs = nextTargetGap(elapsedMs, rng);
  }
  if (!target && elapsedMs >= nextTargetAtMs) {
    target = spawnTarget(arenaWidth, elapsedMs, rng);
  }

  if (hasMissedPaddle(deflected, paddle, ARENA_HEIGHT)) {
    return { ...state, ball: deflected, paddle, status: "lost", elapsedMs, score, target, nextTargetAtMs };
  }

  const hitPaddle = deflected.vy > 0 && deflected.y + deflected.radius >= paddle.y - paddle.height / 2;
  if (hitPaddle) {
    const speed = Math.min(Math.hypot(deflected.vx, deflected.vy) * speedGainPerHit, maxSpeed);
    const reflected = reflectOffPaddle({ ...deflected, vx: 0, vy: -speed }, paddle, config);
    return {
      ...state,
      ball: reflected,
      paddle,
      status: "playing",
      hits: state.hits + 1,
      elapsedMs,
      score: score + 1,
      target,
      nextTargetAtMs,
    };
  }

  return { ...state, ball: deflected, paddle, elapsedMs, score, target, nextTargetAtMs };
}
