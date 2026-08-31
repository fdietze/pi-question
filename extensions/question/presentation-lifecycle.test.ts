import assert from "node:assert/strict";
import test from "node:test";
import { QuestionPresentationLifecycle } from "./presentation-lifecycle.ts";

test("minimize and expand use fresh presentation generations", () => {
  const lifecycle = new QuestionPresentationLifecycle();
  const first = lifecycle.show();

  assert.equal(lifecycle.state(), "shown");
  assert.equal(lifecycle.minimize(first), true);
  assert.equal(lifecycle.state(), "minimized");

  const second = lifecycle.show();
  assert.notEqual(second, first);
  assert.equal(lifecycle.state(), "shown");
});

test("stale presentation callbacks cannot change the current run", () => {
  const lifecycle = new QuestionPresentationLifecycle();
  const stale = lifecycle.show();
  assert.equal(lifecycle.minimize(stale), true);
  const current = lifecycle.show();

  assert.equal(lifecycle.minimize(stale), false);
  assert.equal(lifecycle.settle(stale), false);
  assert.equal(lifecycle.state(), "shown");
  assert.equal(lifecycle.settle(current), true);
  assert.equal(lifecycle.isSettled(), true);
});

test("terminal settlement is exactly once", () => {
  const lifecycle = new QuestionPresentationLifecycle();
  const generation = lifecycle.show();

  assert.equal(lifecycle.settle(generation), true);
  assert.equal(lifecycle.settle(), false);
  assert.equal(lifecycle.minimize(), false);
  assert.equal(lifecycle.show(), undefined);
});
