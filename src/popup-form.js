export function parseSlideRange(startValue, endValue, totalSlides = null) {
  const startSlide = Number.parseInt(startValue, 10);
  const endSlide = Number.parseInt(endValue, 10);

  if (!Number.isFinite(startSlide) || !Number.isFinite(endSlide)) {
    return { error: "Enter a numeric start and end slide." };
  }
  if (startSlide < 1 || endSlide < startSlide) {
    return { error: "Use a valid slide range, like 1-9." };
  }
  if (totalSlides && endSlide > totalSlides) {
    return { error: `End slide cannot be greater than ${totalSlides}.` };
  }

  return {
    startSlide,
    endSlide,
    slideCount: endSlide - startSlide + 1
  };
}

export function parseMoveDelay(value) {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 10) {
    return { error: "Move delay must be between 0.1 and 10 seconds." };
  }

  return { moveDelayMs: Math.round(seconds * 1000) };
}
