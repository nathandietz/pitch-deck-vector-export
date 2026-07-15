(() => {
  if (window.__pitchVectorCaptureInstalled) {
    return;
  }
  window.__pitchVectorCaptureInstalled = true;

  const TARGET_ASPECT_RATIO = 16 / 9;
  const PAGE_WIDTH_INCHES = 16;
  const PAGE_HEIGHT_INCHES = 9;

  // Content-script state lives only in the current Pitch tab.
  // Captured slide clones are stored here until the background worker asks the page to print.
  const state = {
    slides: [],
    printRoot: null,
    styleNode: null,
    previousTitle: "",
    pageWidth: PAGE_WIDTH_INCHES,
    pageHeight: PAGE_HEIGHT_INCHES
  };

  // The background worker sends simple commands; each command returns a small serializable result.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  });

  // Keep all message names in one switch so unsupported commands fail quietly.
  async function handleMessage(message) {
    switch (message?.type) {
      case "PVC_PING":
        return { ok: true };
      case "PVC_RESET_CAPTURE":
        resetCapture();
        return { ok: true };
      case "PVC_GET_DECK_INFO":
        return getDeckInfo();
      case "PVC_CAPTURE_CURRENT":
        return captureCurrentSlide();
      case "PVC_ENTER_PRINT_MODE":
        return enterPrintMode();
      case "PVC_EXIT_PRINT_MODE":
        exitPrintMode();
        return { ok: true };
      default:
        return { ok: false };
    }
  }

  // Start every export from a clean slate, including any previous temporary print DOM.
  function resetCapture() {
    exitPrintMode();
    state.slides = [];
    state.pageWidth = PAGE_WIDTH_INCHES;
    state.pageHeight = PAGE_HEIGHT_INCHES;
  }

  // Read Pitch's own slide counter first, then use a DOM fallback if Pitch changes that control.
  function getDeckInfo() {
    const slideCountElement = document.querySelector(
      ".player-v2-chrome-controls-slide-count, [data-test-id='player-v2-chrome-controls-slide-count']"
    );
    const slideCount = parseSlideCount(slideCountElement?.textContent || "", true);
    const currentSlide = getCurrentSlideNumber() || slideCount.currentSlide;
    const totalSlides = slideCount.totalSlides || findTotalSlidesFallback();

    if (!totalSlides) {
      throw new Error("Could not read the Pitch deck slide count.");
    }

    return { currentSlide, totalSlides };
  }

  // Pitch marks the visible slide with a zero-based data attribute; convert it to user-facing numbering.
  function getCurrentSlideNumber() {
    const activeSlide = document.querySelector(
      "[data-test-id='current-visible-slide'] .slide[data-slide-index], #current-visible-slide .slide[data-slide-index]"
    );
    const slideIndex = Number.parseInt(activeSlide?.getAttribute("data-slide-index") || "", 10);
    if (Number.isFinite(slideIndex)) {
      return slideIndex + 1;
    }

    return null;
  }

  // Accept both "3 / 12" and "3 of 12" counter formats, plus a plain total for fallback scans.
  function parseSlideCount(text, allowPlainNumber = false) {
    const normalized = text.replace(/\s+/g, " ").trim();
    const fractionMatch = normalized.match(/\b(\d+)\s*(?:\/|of)\s*(\d+)\b/i);
    if (fractionMatch) {
      return {
        currentSlide: Number.parseInt(fractionMatch[1], 10),
        totalSlides: Number.parseInt(fractionMatch[2], 10)
      };
    }

    const numberMatch = allowPlainNumber ? normalized.match(/\b(\d+)\b/) : null;
    if (numberMatch) {
      return {
        currentSlide: null,
        totalSlides: Number.parseInt(numberMatch[1], 10)
      };
    }

    return {
      currentSlide: null,
      totalSlides: null
    };
  }

  // Fallback scan: look only at small visible controls so body text is unlikely to be mistaken for a counter.
  function findTotalSlidesFallback() {
    for (const element of document.querySelectorAll("button, div, span")) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 180 || rect.height > 80 || rect.right < 0 || rect.bottom < 0) {
        continue;
      }

      const slideCount = parseSlideCount(element.textContent || "");
      if (slideCount.totalSlides) {
        return slideCount.totalSlides;
      }
    }

    return null;
  }

  // Wait for the page to settle, clone the active slide, and keep the clone for the final print document.
  async function captureCurrentSlide() {
    await document.fonts?.ready.catch(() => {});
    await waitForImages();

    const slide = findCurrentSlide();
    if (!slide) {
      throw new Error("Could not identify the active slide.");
    }

    const croppedSlide = cloneForPrint(slide.element, slide.rect);
    state.slides.push({
      node: croppedSlide.node,
      width: croppedSlide.width,
      height: croppedSlide.height
    });

    return { slideCount: state.slides.length };
  }

  // Prefer Pitch-specific selectors, then fall back to scoring visible 16:9-ish elements near the viewport center.
  function findCurrentSlide() {
    const pitchSlide = findPitchSlideWrapper();
    if (pitchSlide) {
      return pitchSlide;
    }

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const viewportArea = viewportWidth * viewportHeight;
    const viewportCenterX = viewportWidth / 2;
    const viewportCenterY = viewportHeight / 2;
    const candidates = [];

    for (const element of document.querySelectorAll("main, section, article, div, svg")) {
      const rect = element.getBoundingClientRect();
      if (!isUsefulRect(rect, viewportArea)) {
        continue;
      }

      const ratio = rect.width / rect.height;
      const ratioScore = 1 - Math.min(Math.abs(ratio - 16 / 9) / 0.9, 0.85);
      const centerDistance = Math.hypot(
        rect.left + rect.width / 2 - viewportCenterX,
        rect.top + rect.height / 2 - viewportCenterY
      );
      const centerScore = 1 - Math.min(centerDistance / Math.hypot(viewportWidth, viewportHeight), 0.9);
      const contentScore = hasSlideLikeContent(element) ? 1 : 0.2;
      const oversizePenalty = rect.width > viewportWidth * 0.98 || rect.height > viewportHeight * 0.98 ? 0.45 : 1;
      const depthScore = getDepth(element) * 1200;
      const areaScore = rect.width * rect.height;

      candidates.push({
        element,
        rect,
        score: areaScore * ratioScore * centerScore * contentScore * oversizePenalty + depthScore
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  // Pitch currently renders the visible slide as:
  // current-visible-slide > slide-wrapper > canvas-precision-wrapper > scaled-canvas > slide.
  // Capture the precision wrapper, but measure it in Pitch's fixed slide coordinate system.
  function findPitchSlideWrapper() {
    const stage = document.querySelector('[data-test-id="current-visible-slide"], #current-visible-slide');
    const root = stage || document;
    const precisionWrapper = findCanvasPrecisionWrapper(root);

    if (precisionWrapper) {
      return precisionWrapper;
    }

    const candidates = new Map();
    const selectors = ".canvas-precision-wrapper, .slide-wrapper, .scaled-canvas, .slide[data-slide-index], [data-slide-index]";

    if (stage instanceof Element) {
      candidates.set(stage, stage);
    }

    for (const element of root.querySelectorAll(selectors)) {
      candidates.set(element, element);

      for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        candidates.set(ancestor, ancestor);
        if (ancestor === stage) {
          break;
        }
      }
    }

    return [...candidates.values()]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => isUsefulPitchRect(rect))
      .sort((a, b) => getPitchSlideCandidateScore(b.element, b.rect) - getPitchSlideCandidateScore(a.element, a.rect))[0] || null;
  }

  // Pitch resizes this wrapper and scales its 1920x1080 canvas to fit the browser. Using the
  // wrapper's rendered rectangle would bake the browser width into the export, so use the
  // untransformed slide dimensions instead.
  function findCanvasPrecisionWrapper(root) {
    const activeSlide = root.querySelector(".canvas-precision-wrapper .slide[data-slide-index]");
    const wrapper = activeSlide?.closest(".canvas-precision-wrapper") || root.querySelector(".canvas-precision-wrapper");
    const renderedRect = wrapper?.getBoundingClientRect();

    if (!wrapper || !activeSlide || !isUsefulPitchRect(renderedRect)) {
      return null;
    }

    const size = getUnscaledSlideSize(activeSlide);
    if (!size) {
      return null;
    }

    return {
      element: wrapper,
      rect: size
    };
  }

  // offsetWidth/offsetHeight are layout dimensions before ancestor transforms are applied.
  // That makes them stable when Pitch changes its responsive canvas scale at wider viewports.
  function getUnscaledSlideSize(slide) {
    const computed = getComputedStyle(slide);
    const width = slide.offsetWidth || parseCssPixels(computed.width);
    const height = slide.offsetHeight || parseCssPixels(computed.height) || width / TARGET_ASPECT_RATIO;

    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 260 || height < 140) {
      return null;
    }

    return {
      width,
      height
    };
  }

  // Read a computed pixel value without treating "auto" or an empty value as zero.
  function parseCssPixels(value) {
    const pixels = Number.parseFloat(value);
    return Number.isFinite(pixels) && pixels > 0 ? pixels : null;
  }

  // Prefer larger wrapper/artboard elements and avoid the inner slide layer, which is offset inside the artboard.
  function getPitchSlideCandidateScore(element, rect) {
    const area = rect.width * rect.height;
    const className = typeof element.className === "string" ? element.className : "";
    const classBonus = /canvas-precision-wrapper|slide-wrapper|scaled-canvas/.test(className) ? area * 0.2 : 0;
    const innerSlidePenalty = element.matches?.(".slide[data-slide-index]") ? area * 0.35 : 0;
    return area + classBonus - innerSlidePenalty;
  }

  // Pitch-specific candidates should be large, visible, and very close to the deck's 16:9 page shape.
  function isUsefulPitchRect(rect) {
    if (rect.width < 260 || rect.height < 140) {
      return false;
    }
    if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) {
      return false;
    }
    const ratio = rect.width / rect.height;
    return Math.abs(ratio - TARGET_ASPECT_RATIO) < 0.05;
  }

  // Generic fallback candidates can be a little looser because non-Pitch pages may use different wrappers.
  function isUsefulRect(rect, viewportArea) {
    if (rect.width < 260 || rect.height < 140) {
      return false;
    }
    if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) {
      return false;
    }
    const area = rect.width * rect.height;
    if (area < viewportArea * 0.08 || area > viewportArea * 0.96) {
      return false;
    }
    const ratio = rect.width / rect.height;
    return ratio >= 1.15 && ratio <= 2.35;
  }

  // A slide surface usually contains text or visual media; this avoids selecting empty layout containers.
  function hasSlideLikeContent(element) {
    const textLength = (element.innerText || element.textContent || "").trim().length;
    return textLength > 8 || Boolean(element.querySelector("svg,img,video,canvas,picture"));
  }

  // Deeper nodes are often closer to the real slide than broad page layout containers.
  function getDepth(element) {
    let depth = 0;
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      depth += 1;
    }
    return depth;
  }

  // Clone the slide and normalize its box so Chromium can print it without page-positioning side effects.
  function cloneForPrint(source, rect) {
    const clone = source.cloneNode(true);
    copyCanvasContent(source, clone);
    copyVideoFrames(source, clone);
    inlineComputedStyles(source, clone);
    normalizePitchPrecisionClone(source, clone, rect);

    clone.removeAttribute("id");
    clone.style.boxSizing = "border-box";
    clone.style.position = "relative";
    clone.style.left = "auto";
    clone.style.top = "auto";
    clone.style.right = "auto";
    clone.style.bottom = "auto";
    clone.style.margin = "0";
    clone.style.transform = "none";
    clone.style.transformOrigin = "top left";
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.maxWidth = "none";
    clone.style.maxHeight = "none";
    clone.style.overflow = "hidden";

    const crop = getCenteredAspectCrop(rect.width, rect.height);
    if (crop.width === rect.width && crop.height === rect.height) {
      return {
        node: clone,
        width: rect.width,
        height: rect.height
      };
    }

    const viewport = document.createElement("div");
    viewport.style.boxSizing = "border-box";
    viewport.style.position = "relative";
    viewport.style.width = `${crop.width}px`;
    viewport.style.height = `${crop.height}px`;
    viewport.style.margin = "0";
    viewport.style.overflow = "hidden";
    viewport.style.background = getComputedStyle(source).background || "transparent";

    clone.style.position = "absolute";
    clone.style.left = `${-crop.x}px`;
    clone.style.top = `${-crop.y}px`;
    clone.style.margin = "0";
    clone.style.transform = "none";
    viewport.append(clone);

    return {
      node: viewport,
      width: crop.width,
      height: crop.height
    };
  }

  // Convert Pitch's responsive wrapper back into its fixed slide coordinate system. The printed
  // frame applies the one and only scale needed to fit this 1920x1080 surface onto the PDF page.
  function normalizePitchPrecisionClone(source, clone, rect) {
    if (!source.classList?.contains("canvas-precision-wrapper")) {
      return;
    }

    clone.style.display = "block";
    clone.style.position = "relative";
    clone.style.inset = "auto";
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.margin = "0";
    clone.style.padding = "0";
    clone.style.overflow = "hidden";
    clone.style.transform = "none";
    clone.style.setProperty("--inv-scale", "1");

    const scaledCanvas = clone.querySelector(".scaled-canvas");
    if (scaledCanvas instanceof HTMLElement) {
      scaledCanvas.style.display = "block";
      scaledCanvas.style.position = "absolute";
      scaledCanvas.style.left = "0";
      scaledCanvas.style.top = "0";
      scaledCanvas.style.right = "auto";
      scaledCanvas.style.bottom = "auto";
      scaledCanvas.style.margin = "0";
      scaledCanvas.style.width = `${rect.width}px`;
      scaledCanvas.style.height = `${rect.height}px`;
      scaledCanvas.style.transform = "none";
      scaledCanvas.style.transformOrigin = "left top";
    }

    const slide = clone.querySelector(".slide[data-slide-index]");
    if (slide instanceof HTMLElement) {
      slide.style.position = "relative";
      slide.style.inset = "auto";
      slide.style.width = `${rect.width}px`;
      slide.style.height = `${rect.height}px`;
      slide.style.margin = "0";
      slide.style.transform = "none";
      slide.style.transformOrigin = "left top";
      slide.style.overflow = "hidden";
    }
  }

  // Crop oversized wrappers back to a centered 16:9 page without distorting slide content.
  function getCenteredAspectCrop(width, height) {
    const ratio = width / height;
    if (Math.abs(ratio - TARGET_ASPECT_RATIO) < 0.02) {
      return { x: 0, y: 0, width, height };
    }

    if (ratio > TARGET_ASPECT_RATIO) {
      const cropWidth = height * TARGET_ASPECT_RATIO;
      return {
        x: (width - cropWidth) / 2,
        y: 0,
        width: cropWidth,
        height
      };
    }

    const cropHeight = width / TARGET_ASPECT_RATIO;
    return {
      x: 0,
      y: (height - cropHeight) / 2,
      width,
      height: cropHeight
    };
  }

  // Inline key computed styles so the printed clone does not depend on Pitch's application CSS.
  function inlineComputedStyles(sourceRoot, cloneRoot) {
    const sourceWalker = document.createTreeWalker(sourceRoot, NodeFilter.SHOW_ELEMENT);
    const cloneWalker = document.createTreeWalker(cloneRoot, NodeFilter.SHOW_ELEMENT);

    copyComputedStyle(sourceRoot, cloneRoot);

    while (sourceWalker.nextNode() && cloneWalker.nextNode()) {
      copyComputedStyle(sourceWalker.currentNode, cloneWalker.currentNode);
    }
  }

  // Preserve the CSS properties that affect slide geometry, text, color, and visual effects.
  function copyComputedStyle(source, clone) {
    const computed = getComputedStyle(source);
    const preserved = [
      "align-items",
      "background",
      "background-color",
      "background-image",
      "background-position",
      "background-repeat",
      "background-size",
      "border",
      "border-radius",
      "box-shadow",
      "box-sizing",
      "color",
      "display",
      "filter",
      "flex",
      "flex-direction",
      "font",
      "font-family",
      "font-feature-settings",
      "font-kerning",
      "font-size",
      "font-stretch",
      "font-style",
      "font-variant",
      "font-weight",
      "gap",
      "height",
      "justify-content",
      "letter-spacing",
      "line-height",
      "margin",
      "object-fit",
      "opacity",
      "overflow",
      "padding",
      "position",
      "text-align",
      "text-decoration",
      "text-shadow",
      "text-transform",
      "transform",
      "transform-origin",
      "white-space",
      "width",
      "word-break",
      "z-index"
    ];

    for (const property of preserved) {
      clone.style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
    }
  }

  // Canvas content is bitmap-only; convert readable canvases to images before printing.
  function copyCanvasContent(sourceRoot, cloneRoot) {
    const sourceCanvases = sourceRoot.querySelectorAll("canvas");
    const cloneCanvases = cloneRoot.querySelectorAll("canvas");
    sourceCanvases.forEach((sourceCanvas, index) => {
      const cloneCanvas = cloneCanvases[index];
      if (!cloneCanvas) {
        return;
      }
      try {
        const image = document.createElement("img");
        image.src = sourceCanvas.toDataURL("image/png");
        image.width = sourceCanvas.width;
        image.height = sourceCanvas.height;
        image.style.cssText = cloneCanvas.style.cssText;
        cloneCanvas.replaceWith(image);
      } catch {
        // Cross-origin canvases cannot be read. Leave the cloned canvas in place.
      }
    });
  }

  // Use video posters when available so a printed PDF does not contain blank video elements.
  function copyVideoFrames(sourceRoot, cloneRoot) {
    const sourceVideos = sourceRoot.querySelectorAll("video");
    const cloneVideos = cloneRoot.querySelectorAll("video");
    sourceVideos.forEach((sourceVideo, index) => {
      const cloneVideo = cloneVideos[index];
      if (!cloneVideo) {
        return;
      }

      if (sourceVideo.poster) {
        const image = document.createElement("img");
        image.src = sourceVideo.poster;
        image.style.cssText = cloneVideo.style.cssText;
        cloneVideo.replaceWith(image);
      }
    });
  }

  // Build a temporary print document from the captured slide clones and hide the live Pitch UI while printing.
  function enterPrintMode() {
    exitPrintMode();

    state.previousTitle = document.title;
    document.title = document.title.replace(/\s+-\s+Pitch\s*$/i, "") || "Pitch deck";

    const printRoot = document.createElement("div");
    printRoot.id = "pitch-vector-capture-root";

    for (const slide of state.slides) {
      const page = document.createElement("section");
      page.className = "pitch-vector-capture-page";

      const scale = Math.min(
        (state.pageWidth * 96) / slide.width,
        (state.pageHeight * 96) / slide.height
      );
      const frame = document.createElement("div");
      frame.className = "pitch-vector-capture-frame";
      frame.style.width = `${slide.width}px`;
      frame.style.height = `${slide.height}px`;
      frame.style.transform = `scale(${scale})`;
      frame.style.transformOrigin = "left top";
      frame.append(slide.node.cloneNode(true));

      page.append(frame);
      printRoot.append(page);
    }

    const styleNode = document.createElement("style");
    styleNode.id = "pitch-vector-capture-style";
    styleNode.textContent = `
      @page {
        size: ${state.pageWidth}in ${state.pageHeight}in;
        margin: 0;
      }

      @media print {
        html,
        body {
          width: ${state.pageWidth}in !important;
          min-width: ${state.pageWidth}in !important;
          height: auto !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: visible !important;
          background: white !important;
        }

        body > *:not(#pitch-vector-capture-root) {
          display: none !important;
        }

        #pitch-vector-capture-root {
          display: block !important;
          width: ${state.pageWidth}in !important;
          margin: 0 !important;
          padding: 0 !important;
          background: white !important;
        }

        .pitch-vector-capture-page {
          position: relative !important;
          width: ${state.pageWidth}in !important;
          height: ${state.pageHeight}in !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          break-after: page !important;
          page-break-after: always !important;
          background: white !important;
        }

        .pitch-vector-capture-page:last-child {
          break-after: auto !important;
          page-break-after: auto !important;
        }

        .pitch-vector-capture-frame {
          position: absolute !important;
          left: 0 !important;
          top: 0 !important;
          transform-origin: left top !important;
          overflow: hidden !important;
        }
      }

      @media screen {
        #pitch-vector-capture-root {
          position: fixed !important;
          inset: 0 !important;
          z-index: 2147483647 !important;
          overflow: auto !important;
          background: #1f2937 !important;
          padding: 24px !important;
        }

        .pitch-vector-capture-page {
          display: grid !important;
          place-items: center !important;
          width: min(90vw, ${state.pageWidth * 72}px) !important;
          aspect-ratio: ${state.pageWidth} / ${state.pageHeight} !important;
          margin: 0 auto 24px !important;
          background: white !important;
          overflow: hidden !important;
        }

        .pitch-vector-capture-frame {
          transform-origin: center center !important;
        }
      }
    `;

    document.documentElement.append(styleNode);
    document.body.append(printRoot);
    state.printRoot = printRoot;
    state.styleNode = styleNode;

    return {
      ok: true,
      pageWidth: state.pageWidth,
      pageHeight: state.pageHeight,
      slideCount: state.slides.length
    };
  }

  // Remove temporary print DOM and restore the tab title after the PDF has been generated.
  function exitPrintMode() {
    state.printRoot?.remove();
    state.styleNode?.remove();
    state.printRoot = null;
    state.styleNode = null;
    if (state.previousTitle) {
      document.title = state.previousTitle;
      state.previousTitle = "";
    }
  }

  // Wait for pending images so captured slides do not print half-loaded assets.
  async function waitForImages() {
    const images = [...document.images].filter((image) => !image.complete);
    await Promise.allSettled(
      images.map((image) => new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      }))
    );
  }
})();
