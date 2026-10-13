const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");

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
  if (app.isPackaged) Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
