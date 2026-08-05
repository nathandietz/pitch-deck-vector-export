import { CONTENT_MESSAGE, isSupportedPitchDeckUrl } from "./shared.js";

const DEBUGGER_VERSION = "1.3";
const DEFAULT_PAGE_DELAY_MS = 1000;
const BACKWARD_NAVIGATION_SETTLE_MS = 250;
const VIDEO_FRAME_CAPTURE_MS = 100;
const MAX_CAPTURE_STATES = 1000;
const MIN_MOVE_DELAY_MS = 100;
const MAX_MOVE_DELAY_MS = 10000;

// Read deck metadata from the active tab after making sure the content script is available.
export async function getPitchTabInfo(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedPitchDeckUrl(tab?.url)) {
    throw new Error("Open a Pitch deck at pitch.com/v, /public, or /embed first.");
  }

  await ensureContentScript(tabId);
  return requestTab(tabId, { type: CONTENT_MESSAGE.GET_DECK_INFO });
}

// Capture the requested slide range, place the cloned slides into print mode, and download one PDF.
export async function exportPitchTab({
  tabId,
  startSlide,
  endSlide,
  moveDelayMs,
  overrideDelay = false,
  onStatus = async () => {}
}) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedPitchDeckUrl(tab?.url)) {
    throw new Error("This extension only exports Pitch deck URLs at /v, /public, or /embed.");
  }

  await ensureContentScript(tabId);

  const deckInfo = await requestTab(tabId, { type: CONTENT_MESSAGE.GET_DECK_INFO });
  const totalSlides = deckInfo.totalSlides;
  const rangeStart = clampInteger(startSlide, 1, totalSlides, 1);
  const rangeEnd = clampInteger(endSlide, rangeStart, totalSlides, totalSlides);
  const moveDelay = clampInteger(
    moveDelayMs,
    MIN_MOVE_DELAY_MS,
    MAX_MOVE_DELAY_MS,
    DEFAULT_PAGE_DELAY_MS
  );
  const target = { tabId };
  let attached = false;

  try {
    await onStatus("Preparing capture...");
    await chrome.debugger.attach(target, DEBUGGER_VERSION);
    attached = true;
    await chrome.debugger.sendCommand(target, "Page.enable");
    await clickDeck(target);

    await requestTab(tabId, { type: CONTENT_MESSAGE.RESET_CAPTURE });
    await onStatus(`Moving to start slide ${rangeStart} of ${totalSlides}...`);
    const movedToStart = await navigateToSlide(
      tabId,
      target,
      rangeStart,
      totalSlides,
      moveDelay,
      overrideDelay
    );
    if (!movedToStart) {
      await waitForSlideSettled(tabId, moveDelay, overrideDelay);
    }
    let videoFrames = await captureVisibleVideoFrames(
      tabId,
      target,
      overrideDelay ? moveDelay : VIDEO_FRAME_CAPTURE_MS
    );

    let slideCount = 0;
    let captureStates = 0;

    // A forward key can reveal a Pitch build without changing currentSlide. Keep advancing
    // until a key produces no new rendered state, rather than assuming one key equals one page.
    while (captureStates < MAX_CAPTURE_STATES) {
      const currentInfo = await requestTab(tabId, { type: CONTENT_MESSAGE.GET_DECK_INFO });
      if (currentInfo.currentSlide > rangeEnd) {
        break;
      }

      await onStatus(`Capturing slide ${currentInfo.currentSlide} of ${rangeEnd}...`);
      const capture = await requestTab(tabId, {
        type: CONTENT_MESSAGE.CAPTURE_CURRENT,
        videoFrames
      });
      slideCount = capture.slideCount;
      captureStates += 1;

      await advanceSlide(target);
      // Let CSS transitions finish and deferred videos paint before taking a screenshot.
      await waitForSlideSettled(tabId, moveDelay, overrideDelay);
      videoFrames = await captureVisibleVideoFrames(
        tabId,
        target,
        overrideDelay ? moveDelay : VIDEO_FRAME_CAPTURE_MS
      );

      const nextInfo = await requestTab(tabId, { type: CONTENT_MESSAGE.GET_DECK_INFO });
      if (nextInfo.currentSlide > rangeEnd) {
        break;
      }

      const sameSlide = nextInfo.currentSlide === currentInfo.currentSlide;
      const sameRenderedState = currentInfo.stateKey && nextInfo.stateKey
        ? currentInfo.stateKey === nextInfo.stateKey
        : sameSlide;

      // If Pitch did not move to another slide or build, this is the end of the deck (or range).
      if (sameSlide && sameRenderedState) {
        break;
      }
    }

    if (captureStates >= MAX_CAPTURE_STATES) {
      throw new Error("The deck did not reach a stable end while exporting.");
    }

    if (slideCount === 0) {
      throw new Error("Could not find the slide surface on this Pitch page.");
    }

    await onStatus("Preparing PDF layout...");

    const printSetup = await requestTab(tabId, { type: CONTENT_MESSAGE.ENTER_PRINT_MODE });
    await onStatus("Generating PDF...");
    const pdf = await chrome.debugger.sendCommand(target, "Page.printToPDF", {
      displayHeaderFooter: false,
      printBackground: true,
      preferCSSPageSize: true,
      landscape: printSetup.pageWidth > printSetup.pageHeight,
      paperWidth: printSetup.pageWidth,
      paperHeight: printSetup.pageHeight,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      scale: 1,
      generateTaggedPDF: true,
      generateDocumentOutline: true
    });

    if (!pdf?.data) {
      throw new Error("The browser did not return PDF data.");
    }

    const filename = makeFilename(tab.title || "pitch-deck", rangeStart, rangeEnd, totalSlides);
    await onStatus("Downloading PDF...");
    await chrome.downloads.download({
      url: `data:application/pdf;base64,${pdf.data}`,
      filename,
      saveAs: false
    });

    return {
      slideCount,
      filename,
      startSlide: rangeStart,
      endSlide: rangeEnd,
      totalSlides
    };
  } finally {
    await requestTab(tabId, { type: CONTENT_MESSAGE.EXIT_PRINT_MODE }).catch(() => {});
    if (attached) {
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
}

// Content scripts can disappear after navigation, so ping first and inject only when needed.
async function ensureContentScript(tabId) {
  try {
    await requestTab(tabId, { type: CONTENT_MESSAGE.PING });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });
  }
}

// Focus the deck before sending keyboard events; Pitch ignores arrows until the viewer is active.
async function clickDeck(target) {
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 10,
    y: 10,
    button: "left",
    clickCount: 1
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: 10,
    y: 10,
    button: "left",
    clickCount: 1
  });
}

// Pitch uses normal arrow-key navigation in public decks.
async function advanceSlide(target) {
  await dispatchKey(target, {
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
    key: "ArrowRight",
    code: "ArrowRight"
  });
}

// Moving backward lets the exporter recover when the requested range starts before the current slide.
async function retreatSlide(target) {
  await dispatchKey(target, {
    windowsVirtualKeyCode: 37,
    nativeVirtualKeyCode: 37,
    key: "ArrowLeft",
    code: "ArrowLeft"
  });
}

// Step one slide at a time until Pitch reports that the target slide is visible.
async function navigateToSlide(
  tabId,
  target,
  slideNumber,
  totalSlides,
  forwardSettleMs = DEFAULT_PAGE_DELAY_MS,
  overrideDelay = false
) {
  for (let attempt = 0; attempt <= totalSlides + 2; attempt += 1) {
    const deckInfo = await requestTab(tabId, { type: CONTENT_MESSAGE.GET_DECK_INFO });
    const currentSlide = deckInfo.currentSlide;

    if (currentSlide === slideNumber) {
      return attempt > 0;
    }

    if (!Number.isFinite(currentSlide)) {
      throw new Error("Could not read the current Pitch slide number.");
    }

    if (currentSlide < slideNumber) {
      await advanceSlide(target);
      await waitForSlideSettled(tabId, forwardSettleMs, overrideDelay);
    } else {
      await retreatSlide(target);
      await sleep(overrideDelay ? forwardSettleMs : BACKWARD_NAVIGATION_SETTLE_MS);
    }
  }

  throw new Error(`Could not navigate to slide ${slideNumber}.`);
}

async function waitForSlideSettled(tabId, delayMs, overrideDelay) {
  if (overrideDelay) {
    await sleep(delayMs);
    await requestTab(tabId, { type: CONTENT_MESSAGE.WAIT_FOR_VIDEOS });
    return;
  }

  await requestTab(tabId, {
    type: CONTENT_MESSAGE.WAIT_FOR_ANIMATIONS,
    maxWaitMs: delayMs
  });
}

// Capture only the live video rectangles. The rest of the slide continues through the
// vector print pipeline, while these PNGs bypass media/CORS and cloned-video limitations.
async function captureVisibleVideoFrames(tabId, target, captureDelayMs = VIDEO_FRAME_CAPTURE_MS) {
  const captureMode = await requestTab(tabId, { type: CONTENT_MESSAGE.ENTER_VIDEO_CAPTURE_MODE });
  if (!captureMode?.videoCount) {
    await requestTab(tabId, { type: CONTENT_MESSAGE.EXIT_VIDEO_CAPTURE_MODE }).catch(() => {});
    return [];
  }

  try {
    await sleep(captureDelayMs);
    const videos = await requestTab(tabId, { type: CONTENT_MESSAGE.GET_VIDEO_RECTS });
    const frames = [];

    for (const video of videos || []) {
      try {
        const screenshot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
          clip: {
            x: video.x,
            y: video.y,
            width: video.width,
            height: video.height,
            scale: 1
          }
        });

        if (screenshot?.data) {
          frames.push({ index: video.index, data: screenshot.data });
        }
      } catch {
        // The content script's current-frame/poster fallback handles this video.
      }
    }

    return frames;
  } finally {
    await requestTab(tabId, { type: CONTENT_MESSAGE.EXIT_VIDEO_CAPTURE_MODE }).catch(() => {});
  }
}

// Chromium's debugger API expects separate keyDown and keyUp events for reliable navigation.
async function dispatchKey(target, eventBase) {
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    ...eventBase,
    type: "keyDown"
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    ...eventBase,
    type: "keyUp"
  });
}

// Convert content-script error responses into thrown errors so the export flow can use try/finally.
async function requestTab(tabId, message) {
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (response?.error) {
    throw new Error(response.error);
  }
  return response;
}

// Small delay helper for Pitch animations and slide state updates.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Clamp user input to a known deck range before the exporter starts moving through slides.
export function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

// Build a filesystem-safe filename while preserving enough of the deck title to be recognizable.
export function makeFilename(title, startSlide, endSlide, totalSlides) {
  const cleanTitle = title
    .replace(/\s+-\s+Pitch\s*$/i, "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "pitch-deck";

  return startSlide === 1 && endSlide === totalSlides
    ? `${cleanTitle}.pdf`
    : `${cleanTitle} slides ${startSlide}-${endSlide}.pdf`;
}
