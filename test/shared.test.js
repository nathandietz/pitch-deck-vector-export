import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CONTENT_MESSAGE, isSupportedPitchDeckUrl } from "../src/shared.js";

test("recognizes supported Pitch deck URLs", () => {
  for (const url of [
    "https://pitch.com/v/example",
    "https://pitch.com/public/example",
    "https://pitch.com/embed/example"
  ]) {
    assert.equal(isSupportedPitchDeckUrl(url), true);
  }
});

test("rejects unsupported or misleading URLs", () => {
  for (const url of [
    "http://pitch.com/v/example",
    "https://pitch.com/workspace/example",
    "https://example.com/v/example",
    "https://pitch.com.evil.example/v/example",
    null
  ]) {
    assert.equal(isSupportedPitchDeckUrl(url), false);
  }
});

test("keeps the classic content-script protocol aligned with the shared module", async () => {
  const contentSource = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
  const contentMessages = new Set(
    [...contentSource.matchAll(/"(PVC_[A-Z_]+)"/g)].map((match) => match[1])
  );

  assert.deepEqual(contentMessages, new Set(Object.values(CONTENT_MESSAGE)));
});
