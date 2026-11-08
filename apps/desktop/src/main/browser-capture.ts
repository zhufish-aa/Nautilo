import { nativeImage, type WebContents } from "electron";
import { BrowserToolError, browserDeadline } from "./browser-errors";
import { browserCommand } from "./browser-protocol";

type Clip = { x: number; y: number; width: number; height: number };

async function captureDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error("Capture surface did not respond")),
          2500,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function captureBrowserPage(
  wc: WebContents,
  options: { scale?: "css" | "device"; clip?: Clip } = {},
  check = () => {},
) {
  const viewport = await browserDeadline(
    wc.executeJavaScriptInIsolatedWorld(1001, [
      { code: "({width:innerWidth,height:innerHeight,devicePixelRatio})" },
    ]),
    5000,
    "screenshot viewport metrics",
  );
  const clip = options.clip;
  if (
    clip &&
    (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) ||
      clip.x < 0 ||
      clip.y < 0 ||
      clip.width <= 0 ||
      clip.height <= 0 ||
      clip.x + clip.width > viewport.width ||
      clip.y + clip.height > viewport.height)
  ) {
    throw new BrowserToolError(
      "invalid_screenshot_clip",
      "The screenshot region must fit inside the CSS viewport.",
      { viewport },
      undefined,
      false,
    );
  }
  const errors: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    check();
    try {
      wc.invalidate();
      let image;
      if (attempt === 0)
        image = await captureDeadline(
          wc.capturePage(undefined, { stayAwake: true }),
        );
      else {
        const shot = await browserCommand(
          wc,
          "Page.captureScreenshot",
          {
            format: "jpeg",
            quality: 75,
            fromSurface: attempt === 1,
            captureBeyondViewport: false,
          },
          2500,
        );
        image = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
      }
      if (image.isEmpty()) throw Error("The browser returned an empty frame");
      check();
      const source = image.getSize();
      if (options.scale !== "device")
        image = image.resize({
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
        });
      const size = image.getSize(),
        scaleX = size.width / viewport.width,
        scaleY = size.height / viewport.height;
      if (clip)
        image = image.crop({
          x: Math.round(clip.x * scaleX),
          y: Math.round(clip.y * scaleY),
          width: Math.max(1, Math.round(clip.width * scaleX)),
          height: Math.max(1, Math.round(clip.height * scaleY)),
        });
      return {
        data: image.toJPEG(75).toString("base64"),
        metadata: {
          url: wc.getURL(),
          coordinateUnit: "css-pixels",
          viewport: { ...viewport, zoomFactor: wc.getZoomFactor() },
          image: {
            ...image.getSize(),
            scaleX,
            scaleY,
            origin: clip ? { x: clip.x, y: clip.y } : { x: 0, y: 0 },
          },
          sourcePixels: source,
          attempts: attempt + 1,
        },
      };
    } catch (error) {
      check();
      errors.push(error instanceof Error ? error.message : String(error));
      if (attempt < 2)
        await new Promise((resolve) =>
          setTimeout(resolve, 120 * (attempt + 1)),
        );
    }
  }
  throw new BrowserToolError(
    "screenshot_surface_unavailable",
    "The tab did not provide a capture surface after three attempts.",
    { attempts: 3, causes: errors },
    "Read the current page as text or try the screenshot again when the tab finishes rendering.",
  );
}
