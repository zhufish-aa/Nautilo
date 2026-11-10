import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeImage,type WebContents } from "electron";
import { browserDeadline } from "./browser-errors";
import { browserCommand } from "./browser-protocol";

/** Human-facing thumbnails, kept separate from the frequently saved tab manifest. */
export class BrowserSpacePreviews {
  private cache = new Map<string, { image: string; stamp: string; at: number }>();
  constructor(private readonly directory: string) {}

  private path(id: string) {
    if (!/^[\w-]{1,160}$/.test(id)) throw Error("Invalid browser space");
    return join(this.directory, id + ".jpg");
  }

  async image(id: string): Promise<string | undefined> {
    const cached = this.cache.get(id);
    if (cached) return cached.image;
    try {
      const bytes = await readFile(this.path(id));
      if (bytes.length > 256000) return undefined;
      const image = "data:image/jpeg;base64," + bytes.toString("base64");
      this.cache.set(id, { image, stamp: "", at: 0 });
      return image;
    } catch { return undefined; }
  }

  async capture(id: string, page: WebContents, stamp: string): Promise<string | undefined> {
    const previous = this.cache.get(id);
    if (previous?.stamp === stamp && Date.now() - previous.at < 5000) return previous.image;
    try {
      let capture = await browserDeadline(page.capturePage(undefined,{stayAwake:true}), 1000, "window preview");
      if(capture.isEmpty()) {
        const result=await browserCommand(page,"Page.captureScreenshot",{format:"jpeg",quality:66,fromSurface:false,captureBeyondViewport:false},1000);
        capture=nativeImage.createFromBuffer(Buffer.from(result.data,"base64"));
      }
      if (!capture.isEmpty()) {
        const bytes = capture.resize({ width: 640 }).toJPEG(66);
        const image = "data:image/jpeg;base64," + bytes.toString("base64");
        this.cache.set(id, { image, stamp, at: Date.now() });
        await mkdir(this.directory, { recursive: true });
        await writeFile(this.path(id), bytes, { mode: 0o600 }).catch(() => {});
        return image;
      }
    } catch { /* Retain the last preview; never navigate or reload for a thumbnail. */ }
    return this.image(id);
  }

  forget(id: string) {
    this.cache.delete(id);
    void unlink(this.path(id)).catch(() => {});
  }
}
