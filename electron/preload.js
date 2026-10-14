const { contextBridge, ipcRenderer } = require("electron");

// Load everything once at startup. It's a synchronous call, so the app's existing
// synchronous code keeps working as it does with the browser's localStorage.
const cache = ipcRenderer.sendSync("storage:load") || {};

const storage = {
  getItem: (key) =>
    Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null,
  setItem: (key, value) => {
    cache[key] = String(value);
    ipcRenderer.send("storage:set", key, String(value));
  },
  removeItem: (key) => {
    delete cache[key];
    ipcRenderer.send("storage:remove", key);
  },
  key: (i) => Object.keys(cache)[i] ?? null,
  length: () => Object.keys(cache).length,
};

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  storage,
  printers: () => ipcRenderer.invoke("print:printers"),
  print: (deviceName) => ipcRenderer.invoke("print:run", deviceName),
  printPreview: () => ipcRenderer.invoke("print:preview"),
});
