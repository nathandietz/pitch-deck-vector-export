import { isSupportedPitchDeckUrl } from "./shared.js";

const DEBUGGER_VERSION = "1.3";
const ADVANCE_SETTLE_MS = 850;
const NAVIGATION_SETTLE_MS = 100;

// Route popup requests to the small background actions that need extension-only permissions.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_ACTIVE_PITCH_TAB_INFO") {
    getPitchTabInfo(message.tabId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "EXPORT_ACTIVE_PITCH_TAB") {
    exportPitchTab(message.tabId, message.startSlide, message.endSlide)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

// Read deck metadata from the active tab after making sure the content script is available.
async function getPitchTabInfo(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedPitchDeckUrl(tab?.url)) {
    throw new Error("Open a Pitch deck at pitch.com/v, /public, or /embed first.");
  }

  await ensureContentScript(tabId);
  return requestTab(tabId, { type: "PVC_GET_DECK_INFO" });
}

// Capture the requested slide range, place the cloned slides into print mode, and download one PDF.
async function exportPitchTab(tabId, startSlide, endSlide) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedPitchDeckUrl(tab?.url)) {
    throw new Error("This extension only exports Pitch deck URLs at /v, /public, or /embed.");
  }

  await ensureContentScript(tabId);

  const deckInfo = await requestTab(tabId, { type: "PVC_GET_DECK_INFO" });
  const totalSlides = deckInfo.totalSlides;
  const rangeStart = clampInteger(startSlide, 1, totalSlides, 1);
  const rangeEnd = clampInteger(endSlide, rangeStart, totalSlides, totalSlides);
  const slidesToCapture = rangeEnd - rangeStart + 1;

  const target = { tabId };
  let attached = false;

  try {
    await chrome.debugger.attach(target, DEBUGGER_VERSION);
    attached = true;
    await chrome.debugger.sendCommand(target, "Page.enable");
    await clickDeck(target);

    await requestTab(tabId, { type: "PVC_RESET_CAPTURE" });
    await navigateToSlide(tabId, target, rangeStart, totalSlides);

    let slideCount = 0;

    for (let attempt = 0; attempt < slidesToCapture; attempt += 1) {
      const capture = await requestTab(tabId, { type: "PVC_CAPTURE_CURRENT" });
      slideCount = capture.slideCount;

      if (attempt < slidesToCapture - 1) {
        await advanceSlide(target);
        await sleep(ADVANCE_SETTLE_MS);
      }
    }

    if (slideCount === 0) {
      throw new Error("Could not find the slide surface on this Pitch page.");
    }

    await notifyExportStatus(tabId, "Saving PDF...");

    const printSetup = await requestTab(tabId, { type: "PVC_ENTER_PRINT_MODE" });
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

    const filename = makeFilename(tab.title || "pitch-deck", rangeStart, rangeStart + slideCount - 1, totalSlides);
    await chrome.downloads.download({
      url: `data:application/pdf;base64,${pdf.data}`,
      filename,
      saveAs: false
    });

    return {
      slideCount,
      filename,
      startSlide: rangeStart,
      endSlide: rangeStart + slideCount - 1,
      totalSlides
    };
  } finally {
    await requestTab(tabId, { type: "PVC_EXIT_PRINT_MODE" }).catch(() => {});
    if (attached) {
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
}

// Content scripts can disappear after navigation, so ping first and inject only when needed.
async function ensureContentScript(tabId) {
  try {
    await requestTab(tabId, { type: "PVC_PING" });
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
async function navigateToSlide(tabId, target, slideNumber, totalSlides) {
  for (let attempt = 0; attempt <= totalSlides + 2; attempt += 1) {
    const deckInfo = await requestTab(tabId, { type: "PVC_GET_DECK_INFO" });
    const currentSlide = deckInfo.currentSlide;

    if (currentSlide === slideNumber) {
      return;
    }

    if (!Number.isFinite(currentSlide)) {
      throw new Error("Could not read the current Pitch slide number.");
    }

    if (currentSlide < slideNumber) {
      await advanceSlide(target);
    } else {
      await retreatSlide(target);
    }

    await sleep(NAVIGATION_SETTLE_MS);
  }

  throw new Error(`Could not navigate to slide ${slideNumber}.`);
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

// Progress messages are best-effort; the export should keep going if the popup closes.
async function notifyExportStatus(tabId, status) {
  await chrome.runtime.sendMessage({
    type: "EXPORT_STATUS",
    tabId,
    status
  }).catch(() => {});
}

// Small delay helper for Pitch animations and slide state updates.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Clamp user input to a known deck range before the exporter starts moving through slides.
function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

// Build a filesystem-safe filename while preserving enough of the deck title to be recognizable.
function makeFilename(title, startSlide, endSlide, totalSlides) {
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
