import test from "node:test";
import assert from "node:assert/strict";

import { clampInteger, makeFilename } from "../src/exporter.js";

test("clamps integer input and uses the fallback for invalid values", () => {
  assert.equal(clampInteger("4", 1, 10, 1), 4);
  assert.equal(clampInteger(-2, 1, 10, 1), 1);
  assert.equal(clampInteger(15, 1, 10, 1), 10);
  assert.equal(clampInteger("nope", 1, 10, 3), 3);
});

test("creates a clean filename for a full deck", () => {
  assert.equal(makeFilename("Quarterly: Review - Pitch", 1, 12, 12), "Quarterly Review.pdf");
});

test("includes the range in partial-deck filenames", () => {
  assert.equal(makeFilename("Quarterly Review", 3, 7, 12), "Quarterly Review slides 3-7.pdf");
});
