const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');

// Keep a global reference of the window object so it isn't garbage collected.
let mainWindow;

// The product is now called "KG TRF Tool". Pin the user-data folder to the
// folder the previous build used, otherwise Electron would create a new empty
// profile and every saved setting / RPA recording would look "reset" after an
// upgrade.
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'trafficdrive'));
} catch (_) {}

// Linux: several distributions (Ubuntu 24.04+) restrict unprivileged user
// namespaces, which makes Electron's Chromium sandbox abort at startup. The
// renderer already runs with sandbox:false and Playwright is launched with
// --no-sandbox, so disabling the outer sandbox keeps Linux working exactly
// like the Windows build. Windows/macOS are untouched.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// --- Backend server --------------------------------------------------------
// The dashboard (index.html) talks to a REST API on localhost:3000 to start
// / stop / pause traffic campaigns. We start that server inside the Electron
// main process so the user doesn't need to run a separate Node process.
let backendServer = null;
let serverModule = null;

// Check whether a backend is already answering on port 3000. This lets a
// second launch reuse the running backend instead of showing a dashboard that
// can never reach the API.
function isBackendHealthy() {
  return new Promise((resolve) => {
    const req = require('http').get(
      { host: '127.0.0.1', port: 3000, path: '/api/health', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(res.statusCode === 200 && body.includes('"status":"ok"')));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startBackend() {
  try {
    // Load the server module (doesn't start listening yet)
    serverModule = require('./server.js');
    console.log('[Backend] Server module loaded.');
  } catch (err) {
    console.error('[Backend] Failed to load server module:', err.message);
    backendServer = null;
    return;
  }

  // Retry a few times so a slow-exiting previous instance (or a port that is
  // still being released) can't leave this window permanently disconnected.
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      backendServer = await serverModule.startServer();
      console.log('[Backend] Server started on port 3000.');
      return;
    } catch (err) {
      if (err.code === 'EADDRINUSE' && await isBackendHealthy()) {
        console.log('[Backend] Existing backend detected on port 3000; reusing it.');
        backendServer = null;
        return;
      }
      console.error(`[Backend] Start attempt ${attempt}/10 failed:`, err.message);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  console.error('[Backend] Could not start server after 10 attempts.');
  backendServer = null;
}

function stopBackend() {
  if (backendServer) {
    try { backendServer.close(); } catch (_) {}
    backendServer = null;
  }
  serverModule = null;
}

// --- Main window -----------------------------------------------------------

function createWindow() {
  try {
    console.log('[Main] Creating main window...');
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1100,
      minHeight: 700,
      title: 'KG TRF Tool v5.9.4',
      backgroundColor: '#1a1a1a',
      autoHideMenuBar: true,
      icon: path.join(__dirname, 'logo.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      },
      show: false // Don't show until ready-to-show fires
    });

    let hasShown = false;

    // Show window when the page is loaded
    mainWindow.once('ready-to-show', () => {
      console.log('[Main] Window ready to show');
      if (mainWindow && !hasShown) {
        hasShown = true;
        mainWindow.show();
        mainWindow.focus();
      }
    });

    // Fallback: show window after 5 seconds even if ready-to-show never fires
    setTimeout(() => {
      if (mainWindow && !hasShown) {
        console.log('[Main] Showing window via fallback timer');
        hasShown = true;
        mainWindow.show();
        mainWindow.focus();
      }
    }, 5000);

    // Handle page load errors — retry once, then show error page
    let loadRetries = 0;
    const MAX_RETRIES = 2;

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error('[Main] Load failed:', errorCode, errorDescription);

      // Skip aborted navigations (errorCode -3) — these are normal during reloads
      if (errorCode === -3) return;

      if (loadRetries < MAX_RETRIES && mainWindow) {
        loadRetries++;
        console.log(`[Main] Retrying load (${loadRetries}/${MAX_RETRIES})...`);
        setTimeout(() => {
          if (!mainWindow) return;
          const indexPath = path.join(__dirname, 'index.html');
          const fileUrl = require('url').pathToFileURL(indexPath).toString();
          mainWindow.loadURL(fileUrl).catch(() => {});
        }, 500);
      } else if (mainWindow) {
        console.error('[Main] Max retries reached, showing error page');
        mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
          '<html><body style="background:#1a1a1a;color:#f0f0ff;font-family:sans-serif;' +
          'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0">' +
          '<h1 style="color:#a78bfa">KG TRF Tool</h1>' +
          '<p style="color:#9090b0;margin:10px 0">Failed to load the dashboard.</p>' +
          '<p style="color:#555570;font-size:13px">Please restart the application.</p>' +
          '<p style="color:#555570;font-size:12px;margin-top:20px">Error: ' + errorDescription + ' (' + errorCode + ')</p>' +
          '</body></html>'
        )).catch(() => {});
        if (!hasShown) {
          hasShown = true;
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });

    // Load the dashboard — use loadURL with encoded path to handle spaces in directory name
    const indexPath = path.join(__dirname, 'index.html');
    const fileUrl = require('url').pathToFileURL(indexPath).toString();
    console.log('[Main] Loading:', fileUrl);

    mainWindow.loadURL(fileUrl).then(() => {
      console.log('[Main] Dashboard loaded successfully');
    }).catch(err => {
      console.error('[Main] loadURL failed:', err.message);
    });

    // Open external links in the user's default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // Diagnostics
    mainWindow.webContents.on('render-process-gone', (event, details) => {
      console.error('[Main] Renderer process gone:', details.reason, details.exitCode);
    });
    mainWindow.webContents.on('preload-error', (event, preloadPath, error) => {
      console.error('[Main] Preload error:', preloadPath, error.message);
    });
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[Renderer] ${message}`);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[Main] Page finished loading');
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
      console.log('[Main] Window closed');
    });

    console.log('[Main] Window created');
  } catch (err) {
    console.error('[Main] Error creating window:', err);
    throw err;
  }
}

// --- Menu ------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Single instance -------------------------------------------------------
// The backend binds to a fixed port (3000). If a second copy of the app is
// launched it cannot start the backend and every "Start Campaign" click fails
// with "Failed to fetch". Keep one instance and focus it instead.

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// --- App lifecycle ---------------------------------------------------------

if (gotSingleInstanceLock) app.whenReady().then(async () => {
  // IPC: return the main window's content size for resolution display
  ipcMain.handle('get-window-size', () => {
    if (mainWindow) {
      const size = mainWindow.getContentSize();
      return { success: true, width: size[0], height: size[1] };
    }
    return { success: false, width: 1280, height: 800 };
  });

  // Launch the main dashboard window directly
  createWindow();

  // Start backend server in the background (non-blocking)
  setTimeout(async () => {
    try {
      await startBackend();
    } catch (err) {
      console.error('[Backend] Start failed:', err);
    }
  }, 100);

  buildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
