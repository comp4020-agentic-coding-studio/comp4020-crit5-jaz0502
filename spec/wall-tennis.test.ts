import { describe, expect, it } from "vitest";
import { hasMissedPaddle, step, type Ball, type GameState, type Paddle } from "../src/game/wall-tennis";

// The one rule the week's spec calls for a focused automated test on: the
// ball reaching the paddle's line is a miss unless the paddle is under it.
// Testing hasMissedPaddle directly, rather than scanning the built site,
// because this is a pure function's behaviour, not a page contract.

const paddle: Paddle = { x: 200, y: 700, width: 90, height: 14 };

function ballAt(x: number, y: number): Ball {
  return { x, y, vx: 0, vy: 200, radius: 8 };
}

describe("hasMissedPaddle", () => {
  it("is a miss once the ball reaches the paddle's line with no horizontal overlap", () => {
    const ball = ballAt(paddle.x + paddle.width, paddle.y - paddle.height / 2);
    expect(hasMissedPaddle(ball, paddle, 800)).toBe(true);
  });

  it("is not a miss when the ball is over the paddle at the same line", () => {
    const ball = ballAt(paddle.x, paddle.y - paddle.height / 2);
    expect(hasMissedPaddle(ball, paddle, 800)).toBe(false);
  });

  it("is not a miss before the ball has reached the paddle's line", () => {
    const ball = ballAt(paddle.x + paddle.width, paddle.y - paddle.height / 2 - 100);
    expect(hasMissedPaddle(ball, paddle, 800)).toBe(false);
  });
});

describe("step", () => {
  it("ends the round when the ball passes the paddle with no overlap", () => {
    const state: GameState = {
      paddle,
      ball: ballAt(paddle.x + paddle.width, paddle.y - paddle.height / 2 - 1),
      status: "playing",
      hits: 0,
    };
    const next = step(state, 16, paddle.x);
    expect(next.status).toBe("lost");
  });

  it("bounces the ball back when the paddle is underneath it", () => {
    const state: GameState = {
      paddle,
      ball: ballAt(paddle.x, paddle.y - paddle.height / 2 - 1),
      status: "playing",
      hits: 0,
    };
    const next = step(state, 16, paddle.x);
    expect(next.status).toBe("playing");
    expect(next.ball.vy).toBeLessThan(0);
    expect(next.hits).toBe(1);
  });
});
