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

const PADDLE_WIDTH_RATIO = 90 / 480; // paddle covers this fraction of the arena's width
const PADDLE_HEIGHT = 14;
export const PADDLE_Y = ARENA_HEIGHT - 40;
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

export function createInitialState(arenaWidth: number, paddleCenterX: number = arenaWidth / 2): GameState {
  const paddle: Paddle = {
    x: paddleCenterX,
    y: PADDLE_Y,
    width: arenaWidth * PADDLE_WIDTH_RATIO,
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

  const paddle: Paddle = { ...state.paddle, x: paddleCenterX, width: arenaWidth * PADDLE_WIDTH_RATIO };
  const moved: Ball = {
    ...state.ball,
    x: state.ball.x + state.ball.vx * dt,
    y: state.ball.y + state.ball.vy * dt,
  };
  const bounced = withWallBounces(moved, arenaWidth);

  if (hasMissedPaddle(bounced, paddle, ARENA_HEIGHT)) {
    return { ...state, ball: bounced, paddle, status: "lost" };
  }

  const hitPaddle = bounced.vy > 0 && bounced.y + bounced.radius >= paddle.y - paddle.height / 2;
  if (hitPaddle) {
    const speed = Math.min(Math.hypot(bounced.vx, bounced.vy) * speedGainPerHit, maxSpeed);
    const reflected = reflectOffPaddle({ ...bounced, vx: 0, vy: -speed }, paddle, config);
    return { ...state, ball: reflected, paddle, status: "playing", hits: state.hits + 1 };
  }

  return { ...state, ball: bounced, paddle };
}
