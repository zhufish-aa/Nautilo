import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  powerSaveBlocker,
  Tray,
} from "electron";
import type { RemoteStatus } from "@agenthub/schemas";

/** Keeps the Electron owner of the Rust daemon alive while remote access is enabled. */
export class RemoteBackground {
  private tray?: Tray;
  private wakeLock?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private enabled = false;
  private quitting = false;
  private pending = new Set<string>();

  constructor(
    private readonly icon: string,
    private readonly readStatus: () => Promise<RemoteStatus>,
    private readonly openWorkbench: (settings: boolean) => void,
  ) {}

  get running(): boolean {
    return this.enabled && !this.quitting;
  }

  attach(window: BrowserWindow): void {
    window.on("close", (event) => {
      if (this.enabled && this.tray && !this.quitting) {
        event.preventDefault();
        window.hide();
      }
    });
  }

  async start(): Promise<void> {
    try {
      this.apply(await this.readStatus());
    } catch (error) {
      console.error("Remote background startup:", String(error));
    }
  }

  apply(status: RemoteStatus): void {
    if (this.quitting) return;
    this.enabled = status.supported && status.settings.enabled;
    if (this.enabled && !this.tray) {
      const icon = nativeImage
        .createFromPath(this.icon)
        .resize({ width: 20, height: 20 });
      this.tray = new Tray(icon);
      this.tray.setToolTip("Nautilo · 远程连接已开启");
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开 Nautilo", click: () => this.openWorkbench(false) },
          { label: "远程连接", click: () => this.openWorkbench(true) },
          { type: "separator" },
          { label: "退出 Nautilo", click: () => app.quit() },
        ]),
      );
      this.tray.on("double-click", () => this.openWorkbench(false));
    }
    if (!this.enabled) {
      this.tray?.destroy();
      this.tray = undefined;
    }
    if (
      this.enabled &&
      status.settings.keepAwake &&
      this.wakeLock === undefined
    ) {
      this.wakeLock = powerSaveBlocker.start("prevent-app-suspension");
    }
    if (
      (!this.enabled || !status.settings.keepAwake) &&
      this.wakeLock !== undefined
    ) {
      powerSaveBlocker.stop(this.wakeLock);
      this.wakeLock = undefined;
    }
    for (const device of status.pending) {
      if (!this.pending.has(device.id) && Notification.isSupported()) {
        const notice = new Notification({
          title: "Nautilo · 新设备请求配对",
          body: device.name,
          icon: this.icon,
        });
        notice.on("click", () => this.openWorkbench(true));
        notice.show();
      }
    }
    this.pending = new Set(status.pending.map((device) => device.id));
    this.tray?.setToolTip(
      status.pending.length
        ? `Nautilo · ${status.pending.length} 台设备等待确认`
        : `Nautilo · ${status.devices.filter((d) => d.connected).length} 台设备在线`,
    );
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.enabled || this.quitting) return;
    this.timer = setTimeout(async () => {
      try {
        this.apply(await this.readStatus());
      } catch {
        this.tray?.setToolTip("Nautilo · 后台连接暂不可用");
        this.schedule();
      }
    }, 5000);
    this.timer.unref();
  }

  close(): void {
    this.quitting = true;
    this.enabled = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.wakeLock !== undefined) powerSaveBlocker.stop(this.wakeLock);
    this.tray?.destroy();
    this.tray = undefined;
    this.wakeLock = undefined;
  }
}
