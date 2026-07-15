# Pitch Deck Vector Export

![A screenshot of the plugin GUI in Microsoft Edge](/assets/images/screenshot-01.png)

This Microsoft Edge extension exports any public Pitch.com presentations as a multi-page vector PDF. Unlike screenshot-based exporters that produce raster images, it preserves vector graphics and selectable text wherever Pitch renders them as native DOM or SVG content.

> [!NOTE]
> Exported PDFs can be very large (**~50-200 MB**). File size depends on the number of slides and the amount of high-resolution raster content in the presentation. Large decks may take longer to export and download.

## How this differs from screenshot-based slide exporters

| Screenshot-Based Export | Pitch Deck Vector Export |
|-------------------------|--------------------------|
| JPEG/PNG screenshots | Native PDF export |
| Raster images | Vector graphics where available |
| Text baked into pixels | Selectable text |
| Flat image output | Preserves SVG, text, and layout |
| Resolution-dependent | Resolution-independent vectors |
| Non-editable output | Editable vector artwork where supported |
| Best for previews and sharing | Best for design, printing, and AI workflows |

## Load in Edge

1. Download or clone this repository.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the cloned repository folder.

## Export a presentation

1. Open a public Pitch presentation
    - *Example Deck: https://pitch.com/embed/294e8140-5131-4c7a-83e8-98b20d124b9b/*
3. Click the **Pitch Export** extension icon.
4. Leave **Start** at `1` and **End** at the detected slide count, or choose the slide range you want to export.
5. Click **Export PDF**.

During export, Edge displays a debugger notification because the extension uses Chromium's `Page.printToPDF` API through the `debugger` permission. When the export finishes, the PDF is downloaded using the browser's normal download flow.

## Notes
- Works with public Pitch presentations under `/v/`, `/public/`, or `/embed/`.
- Automatically detects the total number of slides and defaults to exporting the entire presentation.
- Navigates to the requested starting slide before exporting.
- If Pitch changes its viewer implementation, the extension's DOM selectors may need to be updated.
- Vector output depends on how Pitch renders each slide. If a slide is rendered as a bitmap or canvas, that content will remain rasterized because the browser cannot reconstruct vector graphics or selectable text from pixels.
