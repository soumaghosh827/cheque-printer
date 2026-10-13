const { contextBridge } = require("electron");

// What the page is allowed to use from the desktop side
contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
});
