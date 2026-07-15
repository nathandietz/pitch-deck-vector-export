// Shared rules used by the popup and background worker.
// Keeping the supported URL check in one place prevents the two entry points from drifting apart.
export function isSupportedPitchDeckUrl(url) {
  return /^https:\/\/pitch\.com\/(?:v|embed|public)\//.test(url || "");
}
