const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const os = require("os");
const path = require("path");
const fs = require("fs");

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

// ---- Storage: one JSON file in %APPDATA%\cheque-printer\ ----
const dataFile = path.join(app.getPath("userData"), "data.json");
let store = {};
let writeTimer = null;

function loadStore() {
  let raw;
  try {
    raw = fs.readFileSync(dataFile, "utf8");
  } catch {
    store = {}; // first run: no file yet
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0b1120",
    title: "Cheque Printer",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // the page can't reach Node directly
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "index.html"));
}

app.whenReady().then(() => {
  // The packaged app has no menu bar; during development the default one stays,
  // so Ctrl+R (reload) and Ctrl+Shift+I (developer tools) keep working
  if (!gotLock) return;
  loadStore();
  if (app.isPackaged) Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
