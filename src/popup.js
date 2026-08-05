import { parseMoveDelay, parseSlideRange } from "./popup-form.js";
import { isSupportedPitchDeckUrl, RUNTIME_MESSAGE } from "./shared.js";

const exportButton = document.querySelector("#exportButton");
const startSlideInput = document.querySelector("#startSlide");
const endSlideInput = document.querySelector("#endSlide");
const moveDelayInput = document.querySelector("#moveDelaySeconds");
const overrideDelayInput = document.querySelector("#overrideDelay");
const statusNode = document.querySelector("#status");
const statusMessageNode = statusNode.querySelector(".status-message");

let activePitchTabId = null;
let deckSlideCount = null;
let statusTone = "info";

// Disable every interactive control while the background worker is reading or exporting the deck.
function setBusy(isBusy) {
  exportButton.disabled = isBusy;
  startSlideInput.disabled = isBusy;
  endSlideInput.disabled = isBusy;
  moveDelayInput.disabled = isBusy;
  overrideDelayInput.disabled = isBusy;
}

// The status node uses tone classes so the CSS can handle color and animation in one place.
function setStatus(message, tone = "info") {
  statusMessageNode.textContent = message;
  statusTone = tone;
  statusNode.className = `status is-${tone}`;
}

// Read and validate the user's requested range once, then reuse the same result everywhere.
function getSelectedSlideRange() {
  return parseSlideRange(startSlideInput.value, endSlideInput.value, deckSlideCount);
}

function getSelectedSlideCount() {
  const range = getSelectedSlideRange();
  if (range.error) {
    return null;
  }
  return range.slideCount;
}

// Keep the ready message in sync as the user edits the slide range.
function updateReadyStatus(force = false) {
  if (!deckSlideCount || (!force && !["ready", "warning"].includes(statusTone))) {
    return;
  }

  const selectedSlideCount = getSelectedSlideCount();
  if (!selectedSlideCount) {
    setStatus("Enter a valid slide range.", "warning");
    return;
  }

  const slideLabel = selectedSlideCount === 1 ? "slide" : "slides";
  setStatus(`Ready to export ${selectedSlideCount} ${slideLabel}.`, "ready");
}

// The popup only works against the active Pitch tab; everything else is reported immediately.
async function getActivePitchTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isSupportedPitchDeckUrl(tab.url)) {
    throw new Error("Open a Pitch deck at pitch.com/v, /public, or /embed first.");
  }
  return tab;
}

// Ask the content script for deck metadata so the popup can prefill the full slide range.
async function loadDeckInfo() {
  setBusy(true);
  setStatus("Reading deck length...", "busy");
  let exportState = null;

  try {
    const tab = await getActivePitchTab();
    activePitchTabId = tab.id;

    const response = await chrome.runtime.sendMessage({
      type: RUNTIME_MESSAGE.GET_DECK_INFO,
      tabId: tab.id
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not read deck length.");
    }

    deckSlideCount = response.totalSlides;
    startSlideInput.value = "1";
    endSlideInput.value = String(deckSlideCount);
    startSlideInput.max = String(deckSlideCount);
    endSlideInput.max = String(deckSlideCount);
    exportState = response.exportState;

    if (exportState) {
      if (exportState.startSlide != null) {
        startSlideInput.value = String(exportState.startSlide);
      }
      if (exportState.endSlide != null) {
        endSlideInput.value = String(exportState.endSlide);
      }
      setStatus(exportState.status, exportState.tone || "info");
    } else {
      updateReadyStatus(true);
    }
  } catch (error) {
    activePitchTabId = null;
    deckSlideCount = null;
    setStatus(error.message, "warning");
  } finally {
    setBusy(exportState?.phase === "running");
  }
}

exportButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Preparing export...", "busy");

  try {
    const tab = activePitchTabId ? await chrome.tabs.get(activePitchTabId) : await getActivePitchTab();
    activePitchTabId = tab.id;
    const range = getSelectedSlideRange();

    if (range.error) {
      throw new Error(range.error);
    }
    const moveDelay = parseMoveDelay(moveDelayInput.value);
    if (moveDelay.error) {
      throw new Error(moveDelay.error);
    }

    const response = await chrome.runtime.sendMessage({
      type: RUNTIME_MESSAGE.START_EXPORT,
      tabId: tab.id,
      startSlide: range.startSlide,
      endSlide: range.endSlide,
      moveDelayMs: moveDelay.moveDelayMs,
      overrideDelay: overrideDelayInput.checked
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Export failed.");
    }

    setStatus(`Saved slides ${response.startSlide}-${response.endSlide} to Downloads.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
});

// Let Enter behave like the primary button when focus is inside either number field.
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing && !exportButton.disabled) {
    event.preventDefault();
    exportButton.click();
  }
});

// The background worker streams progress back while it captures and prints the deck.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === RUNTIME_MESSAGE.EXPORT_STATUS && message.tabId === activePitchTabId) {
    setStatus(message.status, "busy");
  }
});

startSlideInput.addEventListener("input", updateReadyStatus);
endSlideInput.addEventListener("input", updateReadyStatus);
moveDelayInput.addEventListener("input", updateReadyStatus);

document.addEventListener("DOMContentLoaded", loadDeckInfo);
