import { isSupportedPitchDeckUrl } from "./shared.js";

const exportButton = document.querySelector("#exportButton");
const startSlideInput = document.querySelector("#startSlide");
const endSlideInput = document.querySelector("#endSlide");
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
}

// The status node uses tone classes so the CSS can handle color and animation in one place.
function setStatus(message, tone = "info") {
  statusMessageNode.textContent = message;
  statusTone = tone;
  statusNode.className = `status is-${tone}`;
}

// Read and validate the user's requested range once, then reuse the same result everywhere.
function getSelectedSlideRange() {
  const startSlide = Number.parseInt(startSlideInput.value, 10);
  const endSlide = Number.parseInt(endSlideInput.value, 10);

  if (!Number.isFinite(startSlide) || !Number.isFinite(endSlide)) {
    return { error: "Enter a numeric start and end slide." };
  }
  if (startSlide < 1 || endSlide < startSlide) {
    return { error: "Use a valid slide range, like 1-9." };
  }
  if (deckSlideCount && endSlide > deckSlideCount) {
    return { error: `End slide cannot be greater than ${deckSlideCount}.` };
  }

  return {
    startSlide,
    endSlide,
    slideCount: endSlide - startSlide + 1
  };
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

  try {
    const tab = await getActivePitchTab();
    activePitchTabId = tab.id;

    const response = await chrome.runtime.sendMessage({
      type: "GET_ACTIVE_PITCH_TAB_INFO",
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
    updateReadyStatus(true);
  } catch (error) {
    activePitchTabId = null;
    deckSlideCount = null;
    setStatus(error.message, "warning");
  } finally {
    setBusy(false);
  }
}

exportButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Capturing slides...", "busy");

  try {
    const tab = activePitchTabId ? await chrome.tabs.get(activePitchTabId) : await getActivePitchTab();
    activePitchTabId = tab.id;
    const range = getSelectedSlideRange();

    if (range.error) {
      throw new Error(range.error);
    }

    const response = await chrome.runtime.sendMessage({
      type: "EXPORT_ACTIVE_PITCH_TAB",
      tabId: tab.id,
      startSlide: range.startSlide,
      endSlide: range.endSlide
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
  if (message?.type === "EXPORT_STATUS" && message.tabId === activePitchTabId) {
    setStatus(message.status, "busy");
  }
});

startSlideInput.addEventListener("input", updateReadyStatus);
endSlideInput.addEventListener("input", updateReadyStatus);

document.addEventListener("DOMContentLoaded", loadDeckInfo);
