import { toast } from "../../stores/toast";
import type { MessageKey } from "../../lib/i18n";

export interface ImageSource {
  src: string;
  name?: string;
  path?: string;
}

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/** Extracts the local file path from an agenthub-artifact://…?path= URL. */
export function artifactPathFromSrc(src: string): string | undefined {
  if (!src.startsWith("agenthub-artifact:")) return undefined;
  try {
    return new URL(src).searchParams.get("path") ?? undefined;
  } catch {
    return undefined;
  }
}

function imagePayload(image: ImageSource): { path?: string; dataUrl?: string } {
  const path = image.path ?? artifactPathFromSrc(image.src);
  const dataUrl = !path && image.src.startsWith("data:") ? image.src : undefined;
  return { path, dataUrl };
}

export async function copyImageToClipboard(image: ImageSource, t: Translate): Promise<void> {
  const bridge = window.agenthub;
  if (!bridge) return;
  const payload = imagePayload(image);
  if (!payload.path && !payload.dataUrl) {
    toast.error(t("sessions.media.copyImageFailed"));
    return;
  }
  try {
    const ok = await bridge.images.copyToClipboard(payload);
    if (ok) toast.success(t("sessions.media.imageCopied"));
    else toast.error(t("sessions.media.copyImageFailed"));
  } catch {
    toast.error(t("sessions.media.copyImageFailed"));
  }
}

export async function saveImageAs(image: ImageSource, t: Translate): Promise<void> {
  const bridge = window.agenthub;
  if (!bridge) return;
  const payload = imagePayload(image);
  if (!payload.path && !payload.dataUrl) {
    toast.error(t("sessions.media.saveImageFailed"));
    return;
  }
  try {
    const saved = await bridge.images.saveAs({ ...payload, defaultName: image.name });
    if (saved) toast.success(t("sessions.media.imageSaved"));
  } catch {
    toast.error(t("sessions.media.saveImageFailed"));
  }
}

export async function openFileWithToast(path: string, t: Translate): Promise<void> {
  const bridge = window.agenthub;
  if (!bridge) return;
  try {
    const error = await bridge.shell.openPath(path);
    if (error) toast.error(t("sessions.media.openFailed"));
  } catch {
    toast.error(t("sessions.media.openFailed"));
  }
}

export async function copyPathWithToast(path: string, t: Translate): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    toast.success(t("sessions.media.pathCopied"));
  } catch {
    toast.error(t("sessions.media.openFailed"));
  }
}

const MENU_COPY_IMAGE = "copy-image";
const MENU_SAVE_AS = "save-as";
const MENU_SHOW_IN_FOLDER = "show-in-folder";

/** Native context menu for conversation images. Returns true when a menu was shown. */
export async function popupImageMenu(image: ImageSource, t: Translate): Promise<boolean> {
  const bridge = window.agenthub;
  if (!bridge) return false;
  const path = image.path ?? artifactPathFromSrc(image.src);
  const canCopyOrSave = Boolean(path || image.src.startsWith("data:"));
  const clicked = await bridge.menu.popup([
    { id: MENU_COPY_IMAGE, label: t("sessions.media.copyImage"), enabled: canCopyOrSave },
    { id: MENU_SAVE_AS, label: t("sessions.media.saveImageAs"), enabled: canCopyOrSave },
    { id: "sep-1", label: "", type: "separator" },
    { id: MENU_SHOW_IN_FOLDER, label: t("sessions.media.showInFolder"), enabled: Boolean(path) }
  ]);
  if (clicked === MENU_COPY_IMAGE) await copyImageToClipboard(image, t);
  else if (clicked === MENU_SAVE_AS) await saveImageAs(image, t);
  else if (clicked === MENU_SHOW_IN_FOLDER && path) await bridge.shell.showItemInFolder(path);
  return true;
}

const MENU_OPEN = "open";
const MENU_COPY_PATH = "copy-path";

/** Native context menu for file attachments. */
export async function popupFileMenu(path: string | undefined, t: Translate): Promise<boolean> {
  const bridge = window.agenthub;
  if (!bridge) return false;
  const enabled = Boolean(path);
  const clicked = await bridge.menu.popup([
    { id: MENU_OPEN, label: t("sessions.media.open"), enabled },
    { id: MENU_SHOW_IN_FOLDER, label: t("sessions.media.showInFolder"), enabled },
    { id: "sep-1", label: "", type: "separator" },
    { id: MENU_COPY_PATH, label: t("sessions.media.copyPath"), enabled }
  ]);
  if (!path) return true;
  if (clicked === MENU_OPEN) await openFileWithToast(path, t);
  else if (clicked === MENU_SHOW_IN_FOLDER) await bridge.shell.showItemInFolder(path);
  else if (clicked === MENU_COPY_PATH) await copyPathWithToast(path, t);
  return true;
}

const MENU_COPY_TEXT = "copy-text";

/** Native context menu for message text; copies the captured selection. */
export async function popupTextMenu(selectedText: string, t: Translate): Promise<boolean> {
  const bridge = window.agenthub;
  if (!bridge) return false;
  const clicked = await bridge.menu.popup([
    { id: MENU_COPY_TEXT, label: t("sessions.media.copy"), enabled: selectedText.length > 0 }
  ]);
  if (clicked === MENU_COPY_TEXT && selectedText) {
    await navigator.clipboard.writeText(selectedText);
  }
  return true;
}
