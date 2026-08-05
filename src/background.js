import { exportPitchTab, getPitchTabInfo } from "./exporter.js";
import { RUNTIME_MESSAGE } from "./shared.js";

// Popup pages are short-lived, so the service worker owns export progress.
const exportJobs = new Map();

const messageHandlers = {
  async [RUNTIME_MESSAGE.GET_DECK_INFO]({ tabId }) {
    return {
      ...await getPitchTabInfo(tabId),
      exportState: exportJobs.get(tabId) || null
    };
  },

  async [RUNTIME_MESSAGE.START_EXPORT](request) {
    const { tabId } = request;
    if (exportJobs.get(tabId)?.phase === "running") {
      throw new Error("An export is already in progress for this deck.");
    }

    setExportJob(tabId, {
      phase: "running",
      tone: "busy",
      status: "Preparing export...",
      startSlide: request.startSlide,
      endSlide: request.endSlide,
      moveDelayMs: request.moveDelayMs,
      overrideDelay: request.overrideDelay === true
    });

    try {
      const result = await exportPitchTab({
        tabId,
        startSlide: request.startSlide,
        endSlide: request.endSlide,
        moveDelayMs: request.moveDelayMs,
        overrideDelay: request.overrideDelay === true,
        onStatus: (status) => publishStatus(tabId, status)
      });

      setExportJob(tabId, {
        phase: "complete",
        tone: "success",
        status: `Saved slides ${result.startSlide}-${result.endSlide} to Downloads.`,
        ...result
      });
      return result;
    } catch (error) {
      setExportJob(tabId, {
        phase: "error",
        tone: "error",
        status: error.message
      });
      throw error;
    }
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!Object.hasOwn(messageHandlers, message?.type)) {
    return false;
  }
  const handler = messageHandlers[message.type];

  handler(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

function setExportJob(tabId, patch) {
  exportJobs.set(tabId, {
    ...(exportJobs.get(tabId) || {}),
    ...patch,
    updatedAt: Date.now()
  });
}

// Progress messages are best-effort; an export continues if the popup closes.
async function publishStatus(tabId, status) {
  setExportJob(tabId, { status, tone: "busy", phase: "running" });
  await chrome.runtime.sendMessage({
    type: RUNTIME_MESSAGE.EXPORT_STATUS,
    tabId,
    status
  }).catch(() => {});
}
