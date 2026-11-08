// Preload script runs in an isolated context with access to a limited subset
// of Node.js APIs. We use contextBridge to safely expose a small IPC surface
// to the renderer (index.html) so the dashboard can query the window size
// for resolution display purposes.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficdrive', {
  // Returns { success, width, height } for the current window's content size.
  getWindowSize: () => ipcRenderer.invoke('get-window-size'),
});

window.addEventListener('DOMContentLoaded', () => {
  console.log('TrafficDrive desktop shell loaded.');
});
