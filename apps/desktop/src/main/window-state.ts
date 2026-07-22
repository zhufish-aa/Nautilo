import { app, screen } from "electron";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

const DEFAULT_STATE: WindowState = {
  width: 1360,
  height: 860,
  isMaximized: false
};

function stateFilePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function isVisibleOnSomeDisplay(state: WindowState): boolean {
  if (state.x === undefined || state.y === undefined) return false;
  return screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea;
    return (
      state.x! >= x - 8 &&
      state.y! >= y - 8 &&
      state.x! < x + width &&
      state.y! < y + height
    );
  });
}

/** Read the persisted window bounds so the app can restore them on next launch (F-001). */
export function readWindowState(): WindowState {
  try {
    const file = stateFilePath();
    if (!existsSync(file)) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<WindowState>;
    const state: WindowState = {
      width: Math.max(960, Number(parsed.width) || DEFAULT_STATE.width),
      height: Math.max(640, Number(parsed.height) || DEFAULT_STATE.height),
      x: typeof parsed.x === "number" ? parsed.x : undefined,
      y: typeof parsed.y === "number" ? parsed.y : undefined,
      isMaximized: parsed.isMaximized === true
    };
    if (!isVisibleOnSomeDisplay(state)) {
      state.x = undefined;
      state.y = undefined;
    }
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Debounce-persist window bounds whenever they change. */
export function trackWindowState(win: Electron.BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;

  const save = (): void => {
    if (win.isDestroyed()) return;
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized
    };
    try {
      const file = stateFilePath();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // Persisting window chrome is best-effort; never crash the shell over it.
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("close", save);
}
