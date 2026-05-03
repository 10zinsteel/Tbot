import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { startServer } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const APP_URL = `http://localhost:${PORT}`;

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {import("http").Server | null} */
let httpServer = null;

/** When false, the main window "close" hides to tray instead of exiting. */
let isQuitting = false;

function trayImage() {
  const iconPath = path.join(__dirname, "assets", "tray-icon.png");
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  // 16×16 fallback so Windows always has a tray image
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIwCAP+/B/wXnPmmAAAAAElFTkSuQmCC"
  );
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(APP_URL);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip("TBot");

  const menu = Menu.buildFromTemplate([
    {
      label: "Open TBot",
      click: () => showMainWindow(),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => showMainWindow());
}

app.whenReady().then(async () => {
  try {
    httpServer = await startServer(PORT);
  } catch (err) {
    console.error("TBot: failed to start Express server:", err);
    app.quit();
    return;
  }

  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Main window is usually hidden, not destroyed; tray keeps the app alive on all platforms.
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
});
