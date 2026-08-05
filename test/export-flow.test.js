import test from "node:test";
import assert from "node:assert/strict";

import { exportPitchTab } from "../src/exporter.js";
import { CONTENT_MESSAGE } from "../src/shared.js";

test("captures video early and retries after settling when no frame is available", async () => {
  const events = [];
  const deckInfo = [
    { currentSlide: 24, totalSlides: 25, stateKey: "slide-24" },
    { currentSlide: 24, totalSlides: 25, stateKey: "slide-24" },
    { currentSlide: 24, totalSlides: 25, stateKey: "slide-24" },
    { currentSlide: 25, totalSlides: 25, stateKey: "slide-25" },
    { currentSlide: 25, totalSlides: 25, stateKey: "slide-25" },
    { currentSlide: 25, totalSlides: 25, stateKey: "slide-25" }
  ];
  let capturedSlides = 0;

  globalThis.chrome = {
    tabs: {
      async get() {
        return { url: "https://pitch.com/v/example", title: "Example - Pitch" };
      },
      async sendMessage(_tabId, message) {
        events.push(message.type);
        switch (message.type) {
          case CONTENT_MESSAGE.GET_DECK_INFO:
            return deckInfo.shift();
          case CONTENT_MESSAGE.CAPTURE_CURRENT:
            capturedSlides += 1;
            return { slideCount: capturedSlides };
          case CONTENT_MESSAGE.ENTER_VIDEO_CAPTURE_MODE:
            return { videoCount: 0 };
          case CONTENT_MESSAGE.ENTER_PRINT_MODE:
            return { pageWidth: 16, pageHeight: 9 };
          default:
            return { ok: true };
        }
      }
    },
    scripting: {
      async executeScript() {}
    },
    debugger: {
      async attach() {},
      async detach() {},
      async sendCommand(_target, method, parameters = {}) {
        if (method === "Input.dispatchKeyEvent") {
          events.push(`${parameters.key}:${parameters.type}`);
        }
        if (method === "Page.printToPDF") {
          return { data: "pdf-data" };
        }
        return {};
      }
    },
    downloads: {
      async download() {}
    }
  };

  await exportPitchTab({
    tabId: 1,
    startSlide: 24,
    endSlide: 25,
    moveDelayMs: 1000
  });

  const firstAdvance = events.indexOf("ArrowRight:keyUp");
  const earlyVideoCapture = events.indexOf(
    CONTENT_MESSAGE.ENTER_VIDEO_CAPTURE_MODE,
    firstAdvance
  );
  const settle = events.indexOf(CONTENT_MESSAGE.WAIT_FOR_ANIMATIONS, earlyVideoCapture);
  const lateVideoCapture = events.indexOf(CONTENT_MESSAGE.ENTER_VIDEO_CAPTURE_MODE, settle);

  assert.ok(firstAdvance >= 0);
  assert.ok(earlyVideoCapture > firstAdvance);
  assert.ok(settle > earlyVideoCapture);
  assert.ok(lateVideoCapture > settle);
  assert.equal(capturedSlides, 2);
});
