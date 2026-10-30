const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  shell,
  safeStorage,
  dialog,
} = require("electron");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");

// One data folder, whether running from source or installed (so no data seems to vanish)
app.setPath(
  "userData",
  path.join(app.getPath("appData"), "mal-cheque-printer"),
);

// Only one copy of the app may run, since two would overwrite each other's data file
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// ---- Storage: one JSON file in %APPDATA%\mal-cheque-printer\ ----
const dataFile = path.join(app.getPath("userData"), "data.json");
let store = {};
let writeTimer = null;

function loadStore() {
  let raw;
  try {
    raw = fs.readFileSync(dataFile, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      store = {}; // genuine first run
      return;
    }
    // Any other error: don't risk overwriting real data
    log.error("Could not read data file:", e.message);
    dialog.showErrorBox(
      "Data file unreadable",
      "Close other copies of the app and restart it.",
    );
    app.exit(1);
    return;
  }

  try {
    store = JSON.parse(raw);
  } catch {
    // Unreadable file: keep a copy instead of overwriting it, then start fresh
    fs.writeFileSync(dataFile + ".corrupt-" + Date.now(), raw);
    store = {};
  }
}

function flushStore() {
  clearTimeout(writeTimer);
  writeTimer = null;
  try {
    const tmp = dataFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store)); // write to a temp file first,
    fs.renameSync(tmp, dataFile); // then swap, so a crash can't leave half a file
  } catch (e) {
    console.error("Could not save data:", e);
  }
}

function scheduleFlush() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flushStore, 300);
}

ipcMain.on("storage:load", (e) => {
  e.returnValue = store;
});
ipcMain.on("storage:set", (_e, key, value) => {
  store[key] = String(value);
  scheduleFlush();
});
ipcMain.on("storage:remove", (_e, key) => {
  delete store[key];
  scheduleFlush();
});
app.on("before-quit", flushStore);

// ---- Printing ----
const PRINT_OPTIONS = {
  printBackground: false,
  landscape: true,
  pageSize: "A4",
  margins: { marginType: "none" },
  scaleFactor: 100,
  copies: 1,
};

// The installed printers, for the printer dropdown
ipcMain.handle("print:printers", async (e) => {
  const list = await e.sender.getPrintersAsync();
  return list.map((p) => ({
    name: p.name,
    displayName: p.displayName || p.name,
    isDefault: !!p.isDefault,
  }));
});

// Prints the page that asked. With a printer name the job goes straight to
// that printer, with no dialog. Without one, the Windows dialog opens as before.
ipcMain.handle(
  "print:run",
  (e, deviceName) =>
    new Promise((resolve) => {
      const named = typeof deviceName === "string" && deviceName.length > 0;
      e.sender.print(
        {
          ...PRINT_OPTIONS,
          silent: named,
          ...(named ? { deviceName, color: false } : {}),
        },
        (success, reason) => resolve({ success, reason }),
      );
    }),
);

// Renders the print layout to a PDF and opens it in the default PDF viewer
ipcMain.handle("print:preview", async (e) => {
  const pdf = await e.sender.printToPDF({
    pageSize: "A4",
    landscape: true,
    printBackground: false,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    preferCSSPageSize: true,
  });
  const file = path.join(os.tmpdir(), `cheque-preview-${Date.now()}.pdf`);
  fs.writeFileSync(file, pdf);
  await shell.openPath(file);
  return file;
});

ipcMain.on("app:version", (e) => {
  e.returnValue = app.getVersion();
});

// ---- Device-bound protection: only this Windows account on this PC can read it ----
ipcMain.on("secure:protect", (e, text) => {
  const plain = String(text);
  e.returnValue = safeStorage.isEncryptionAvailable()
    ? "enc:" + safeStorage.encryptString(plain).toString("base64")
    : plain;
});

ipcMain.on("secure:unprotect", (e, text) => {
  try {
    e.returnValue =
      typeof text === "string" && text.startsWith("enc:")
        ? safeStorage.decryptString(Buffer.from(text.slice(4), "base64"))
        : text; // plain text written before protection existed
  } catch {
    e.returnValue = null; // unreadable here (another PC or account)
  }
});

// While developing, the web app sits two folders up (the repo root).
// Packaged later, it is copied beside the app, so this same line will keep working.
const webRoot = app.isPackaged
  ? path.join(process.resourcesPath, "web")
  : path.join(__dirname, "..", "..");

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0b1120",
    title: "MAL Cheque Printer",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // the page can't reach Node directly
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(webRoot, "index.html"));
}

// ---- Updates: checked against the releases repo named in package.json ----
function startUpdateChecks() {
  autoUpdater.logger = log;
  log.transports.file.level = "info";
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) =>
    log.error("Update check failed:", err?.message || err),
  );

  // Log progress every 25% so the file stays readable
  let lastLogged = -1;
  autoUpdater.on("download-progress", (p) => {
    const step = Math.floor(p.percent / 25) * 25;
    if (step !== lastLogged) {
      lastLogged = step;
      log.info(
        `Downloaded ${Math.round(p.percent)}% (${p.transferred}/${p.total} bytes)`,
      );
    }
  });

  // Make sure data is saved before the installer takes over
  autoUpdater.on("before-quit-for-update", flushStore);

  let asked = false;
  autoUpdater.on("update-downloaded", async (info) => {
    if (asked) return; // one question per session
    asked = true;
    // No parent window: the dialog isn't modal to a window that is about to close
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 1, // Enter picks "Later", so an update never interrupts a print by accident
      cancelId: 1,
      title: "Update ready",
      message: `MAL Cheque Printer ${info.version} is ready to install.`,
      detail:
        "Your data is kept. Choose Later to install it the next time you close the app.",
    });
    if (response === 0) autoUpdater.quitAndInstall(false, true); // visible installer, relaunch after
  });

  const check = () =>
    autoUpdater
      .checkForUpdates()
      .catch((e) => log.warn("Check failed:", e?.message || e));
  setTimeout(check, 60 * 1000); // give the app a minute to settle before the heavy work
  setInterval(check, 60 * 60 * 1000);
}

app.whenReady().then(() => {
  // The packaged app has no menu bar; during development the default one stays,
  // so Ctrl+R (reload) and Ctrl+Shift+I (developer tools) keep working
  if (!gotLock) return;
  loadStore();
  if (app.isPackaged) Menu.setApplicationMenu(null);
  createWindow();
  if (app.isPackaged) startUpdateChecks(); // not while running from source
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
