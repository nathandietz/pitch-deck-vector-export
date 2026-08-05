import test from "node:test";
import assert from "node:assert/strict";

import { parseMoveDelay, parseSlideRange } from "../src/popup-form.js";

test("parses a valid slide range", () => {
  assert.deepEqual(parseSlideRange("2", "5", 10), {
    startSlide: 2,
    endSlide: 5,
    slideCount: 4
  });
});

test("rejects invalid slide ranges", () => {
  assert.match(parseSlideRange("", "5", 10).error, /numeric/);
  assert.match(parseSlideRange("4", "2", 10).error, /valid slide range/);
  assert.match(parseSlideRange("1", "11", 10).error, /greater than 10/);
});

test("converts valid movement delays to milliseconds", () => {
  assert.deepEqual(parseMoveDelay("1.25"), { moveDelayMs: 1250 });
});

test("rejects movement delays outside the supported range", () => {
  assert.ok(parseMoveDelay("0.05").error);
  assert.ok(parseMoveDelay("11").error);
  assert.ok(parseMoveDelay("not-a-number").error);
});
