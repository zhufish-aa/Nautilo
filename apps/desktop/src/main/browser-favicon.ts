import type { WebContents } from "electron";

const icons = new Map<string, string>();
export async function browserFavicon(page: WebContents, url: string): Promise<string | undefined> {
  if (icons.has(url)) return icons.get(url);
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    const response = await page.session.fetch(url, { signal: AbortSignal.timeout(2000), credentials: "omit" });
    const mime = response.headers.get("content-type")?.split(";")[0];
    if (!response.ok || !mime?.startsWith("image/") || !response.body) return undefined;
    const reader = response.body.getReader(), parts: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 48000) { await reader.cancel(); return undefined; }
      parts.push(value);
    }
    const data = "data:" + mime + ";base64," + Buffer.concat(parts).toString("base64");
    if (icons.size > 100) icons.delete(icons.keys().next().value!);
    icons.set(url, data);
    return data;
  } catch { return undefined; }
}
