/**
 * I.R.I.S. Electron Main Process
 * - Anchors the frameless Dynamic Island HUD at top center of Windows
 * - Runs unobtrusively in background via Windows System Tray + hardware Ctrl+Space wake
 * - Automatically spawns the Python Real-Time STT Server (`engine_python/voice_server.py`)
 * - Runs Ollama (`llama3.2:3b`) in background + Dual Gemini Pools (Vision + Thinking)
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, screen, globalShortcut, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { getSystemStatsSummary, openWindowsApp, inspectActiveScreen } = require('./os-tools');
const { IrisAIOrchestrator } = require('./ai-orchestrator');
const spotifyApi = require('./spotify-api');
const { integrationsManager } = require('./integrations-manager');

const INSTANCE_LOCK_PATH = path.join(__dirname, '../../config/.iris-instance.json');
const STARTUP_DIR = path.join(
  process.env.APPDATA || '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
const STARTUP_VBS_PATH = path.join(STARTUP_DIR, 'IRIS_AutoStart.vbs');

function isWindowsAutoStartEnabled() {
  try {
    return fs.existsSync(STARTUP_VBS_PATH);
  } catch {
    return false;
  }
}

function setWindowsAutoStart(enabled) {
  try {
    if (enabled) {
      const electronExe = path.join(__dirname, '../../node_modules/electron/dist/electron.exe');
      const appDir = path.join(__dirname, '../..');
      const vbsContent = [
        'Set WshShell = CreateObject("WScript.Shell")',
        `WshShell.CurrentDirectory = "${appDir}"`,
        `WshShell.Run """${electronExe}"" ""${appDir}""", 0, False`,
        ''
      ].join('\r\n');
      fs.mkdirSync(STARTUP_DIR, { recursive: true });
      fs.writeFileSync(STARTUP_VBS_PATH, vbsContent, 'utf8');
      return true;
    }
    if (fs.existsSync(STARTUP_VBS_PATH)) {
      fs.unlinkSync(STARTUP_VBS_PATH);
    }
    return true;
  } catch (err) {
    console.warn('[IRIS AutoStart] Error updating startup entry:', err.message);
    return false;
  }
}

let mainWindow = null;
let tray = null;
let aiOrchestrator = null;
let sttPythonProcess = null;
let lastWakeTime = 0;
let backgroundStealthMode = false;
let doNotDisturbMode = false;
let isCompactState = false;
let hasSpotifyCompact = false;
let currentWinX = null;
let targetWinX = null;
let currentSlot = 'center';
let lastDodgeTime = 0;
let dndDodgeInterval = null;

function writeInstanceState(pythonPid = null) {
  try {
    fs.mkdirSync(path.dirname(INSTANCE_LOCK_PATH), { recursive: true });
    fs.writeFileSync(
      INSTANCE_LOCK_PATH,
      JSON.stringify({ electronPid: process.pid, pythonPid: pythonPid || null }, null, 2),
      'utf8'
    );
  } catch {
    // ignore lock write failures
  }
}

function ensureSingleCleanInstanceSync() {
  let killedAny = false;
  try {
    if (fs.existsSync(INSTANCE_LOCK_PATH)) {
      const prev = JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, 'utf8'));
      if (prev?.pythonPid) {
        try {
          process.kill(prev.pythonPid);
          killedAny = true;
        } catch {
          // old python already exited
        }
      }
      if (prev?.electronPid && prev.electronPid !== process.pid) {
        try {
          process.kill(prev.electronPid);
          killedAny = true;
        } catch {
          // old electron already exited
        }
      }
    }
  } catch {
    // ignore parse/kill errors
  }

  writeInstanceState(null);
  if (killedAny) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    } catch {
      // ignore wait failure
    }
  }
}

ensureSingleCleanInstanceSync();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createIrisTrayIcon() {
  const w = 16;
  const h = 16;
  const raw = Buffer.alloc((1 + w * 4) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < w; x++) {
      const px = rowStart + 1 + x * 4;
      const dx = x - 7.5;
      const dy = y - 7.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 7.4) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
      } else {
        const isLeftEye = x >= 4 && x <= 5 && y >= 5 && y <= 10;
        const isRightEye = x >= 10 && x <= 11 && y >= 5 && y <= 10;
        if (isLeftEye || isRightEye) {
          raw[px] = 255;
          raw[px + 1] = 71;
          raw[px + 2] = 118;
          raw[px + 3] = 255;
        } else {
          raw[px] = 30;
          raw[px + 1] = 29;
          raw[px + 2] = 29;
          raw[px + 3] = 255;
        }
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngBuffer = Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  return nativeImage.createFromBuffer(pngBuffer);
}

function hideIrisWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setSkipTaskbar(true);
  } catch {
    // ignore
  }
  mainWindow.hide();
  updateTrayMenu();
}

function showIrisWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setSkipTaskbar(false);
  } catch {
    // ignore
  }
  mainWindow.showInactive();
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const isVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Hablar con Iris (Ctrl+Espacio)',
      click: () => triggerIrisWake()
    },
    {
      label: isVisible ? 'Ocultar en segundo plano' : 'Mostrar barra flotante',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isVisible()) {
          backgroundStealthMode = true;
          hideIrisWindow();
        } else {
          backgroundStealthMode = false;
          showIrisWindow();
        }
        mainWindow.webContents.send('iris:background-mode-sync', backgroundStealthMode);
      }
    },
    {
      type: 'checkbox',
      label: 'Modo Segundo Plano (Auto-ocultar)',
      checked: backgroundStealthMode,
      click: (menuItem) => {
        backgroundStealthMode = Boolean(menuItem.checked);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('iris:background-mode-sync', backgroundStealthMode);
        }
      }
    },
    {
      type: 'checkbox',
      label: 'Modo No Molestar (Esquivar ratón)',
      checked: doNotDisturbMode,
      click: (menuItem) => {
        doNotDisturbMode = Boolean(menuItem.checked);
        try {
          aiOrchestrator?.updateSettings?.({ doNotDisturb: doNotDisturbMode });
        } catch {
          // ignore
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('iris:dnd-mode-sync', doNotDisturbMode);
        }
        updateTrayMenu();
      }
    },
    {
      type: 'checkbox',
      label: 'Iniciar al encender el PC',
      checked: isWindowsAutoStartEnabled(),
      click: (menuItem) => {
        const enabled = Boolean(menuItem.checked);
        setWindowsAutoStart(enabled);
        try {
          aiOrchestrator?.updateSettings?.({ autoStart: enabled });
        } catch {
          // ignore
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('iris:autostart-sync', enabled);
        }
        updateTrayMenu();
      }
    },
    { type: 'separator' },
    {
      label: 'Salir de I.R.I.S.',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
}

function createSystemTray() {
  if (tray) return;
  try {
    tray = new Tray(createIrisTrayIcon());
    tray.setToolTip('I.R.I.S. — Asistente en Segundo Plano (Ctrl+Espacio)');
    tray.on('click', () => triggerIrisWake());
    updateTrayMenu();
  } catch (err) {
    console.warn('[IRIS Tray] Could not create system tray:', err.message);
  }
}

function startPythonSTTServer() {
  try {
    const scriptPath = path.join(__dirname, '../../engine_python/voice_server.py');
    sttPythonProcess = spawn('python', [scriptPath], {
      windowsHide: true,
      stdio: 'ignore'
    });
    writeInstanceState(sttPythonProcess?.pid);
    sttPythonProcess.on('error', (err) => {
      console.warn('[IRIS STT] Python process error:', err.message);
    });
  } catch (err) {
    console.warn('[IRIS STT] Could not start Python STT server:', err.message);
  }
}

function triggerIrisWake() {
  if (global.isSimulatingSpotifyKeystroke) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const now = Date.now();
  if (now - lastWakeTime < 450) return;
  lastWakeTime = now;

  const wasHidden = !mainWindow.isVisible();
  if (wasHidden) {
    showIrisWindow();
  }
  mainWindow.webContents.send('iris:shortcut-wake', {
    fromBackground: backgroundStealthMode || wasHidden
  });
}

function createIrisTopBarWindow() {
  Menu.setApplicationMenu(null);

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth } = primaryDisplay.workAreaSize;

  const winWidth = 504;
  const winHeight = 104;
  const xPos = Math.round((screenWidth - winWidth) / 2);

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: xPos,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    focusable: true,
    hasShadow: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  if (process.platform === 'win32') {
    const WM_SYSCOMMAND = 0x0112;
    const WM_INITMENU = 0x0116;
    mainWindow.hookWindowMessage(WM_SYSCOMMAND, (wParam) => {
      const cmd = wParam.readUInt32LE(0) & 0xfff0;
      if (cmd === 0xf100) {
        triggerIrisWake();
        return true;
      }
    });
    mainWindow.hookWindowMessage(WM_INITMENU, () => true);
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (global.isSimulatingSpotifyKeystroke) return;
    if (input.type === 'keyDown' && !input.isAutoRepeat && input.code === 'Space' && (input.alt || input.control)) {
      event.preventDefault();
      triggerIrisWake();
    }
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      backgroundStealthMode = true;
      hideIrisWindow();
      mainWindow.webContents.send('iris:background-mode-sync', true);
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../../index.html'));
}

app.whenReady().then(() => {
  startPythonSTTServer();
  createIrisTopBarWindow();
  createSystemTray();

    aiOrchestrator = new IrisAIOrchestrator((bgPayload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('iris:background-reply', bgPayload);
      }
    });
    aiOrchestrator.ensureOllamaRunning();
    const initialSettings = aiOrchestrator.getSettings();
    doNotDisturbMode = Boolean(initialSettings?.doNotDisturb);
    if (initialSettings?.autoStart !== false && !isWindowsAutoStartEnabled()) {
      setWindowsAutoStart(true);
    }
    updateTrayMenu();
    startDndMouseDodgeLoop();

    const registerAllIrisShortcuts = () => {
      const shortcuts = ['CommandOrControl+Space', 'Alt+Space', 'Alt+I'];
      for (const accel of shortcuts) {
        try {
          if (!globalShortcut.isRegistered(accel)) {
            globalShortcut.register(accel, () => {
              triggerIrisWake();
            });
          }
        } catch (err) {
          console.warn(`Could not register ${accel}:`, err);
        }
      }
    };

    global.yieldFocusToSpotify = () => {
      global.isSimulatingSpotifyKeystroke = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.setAlwaysOnTop(false);
          mainWindow.blur();
        } catch {
          // ignore
        }
      }
    };

    global.restoreIrisFocus = () => {
      global.isSimulatingSpotifyKeystroke = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.setAlwaysOnTop(true, 'screen-saver');
        } catch {
          // ignore
        }
      }
    };

    global.rebindIrisShortcuts = registerAllIrisShortcuts;
    registerAllIrisShortcuts();

    ipcMain.handle('iris:ask-ai', (_event, userPrompt) => {
      return aiOrchestrator.handleUserPrompt(userPrompt);
    });

    ipcMain.handle('iris:load-history', () => {
      return aiOrchestrator.loadChatHistory();
    });

    ipcMain.handle('iris:save-history', (_event, messages) => {
      return aiOrchestrator.saveChatHistory(messages);
    });

    ipcMain.handle('iris:get-settings', () => {
      return aiOrchestrator.getSettings();
    });

    ipcMain.handle('iris:update-settings', (_event, updates) => {
      return aiOrchestrator.updateSettings(updates);
    });

    ipcMain.handle('iris:set-autostart', (_event, enabled) => {
      const next = Boolean(enabled);
      const ok = setWindowsAutoStart(next);
      try {
        aiOrchestrator?.updateSettings?.({ autoStart: next });
      } catch {
        // ignore
      }
      updateTrayMenu();
      return { ok, enabled: next };
    });

    ipcMain.handle('iris:list-ollama-models', () => {
      return aiOrchestrator.listOllamaModels();
    });

    ipcMain.handle('iris:artifact-action', (_event, actionPayload) => {
      return aiOrchestrator.executeArtifactAction(actionPayload);
    });

    ipcMain.handle('iris:spotify-status', () => spotifyApi.getStatus());
    ipcMain.handle('iris:spotify-now-playing', () => spotifyApi.getNowPlaying());
    ipcMain.handle('iris:spotify-connect', (_event, clientId) => spotifyApi.connect(clientId));
    ipcMain.handle('iris:spotify-disconnect', () => spotifyApi.disconnect());

    ipcMain.handle('iris:list-integrations', () => integrationsManager.getIntegrationsList());
    ipcMain.handle('iris:connect-integration', (_event, { serviceId, credentials }) => {
      return integrationsManager.connectService(serviceId, credentials);
    });
    ipcMain.handle('iris:disconnect-integration', (_event, serviceId) => {
      return integrationsManager.disconnectService(serviceId);
    });

    ipcMain.handle('iris:get-system-stats', () => getSystemStatsSummary());
    ipcMain.handle('iris:open-app', (_event, query) => openWindowsApp(query));
    ipcMain.handle('iris:inspect-screen', () => inspectActiveScreen());
    ipcMain.handle('iris:run-action', (_event, action) => {
      if (action === 'coding-mode') {
        return openWindowsApp('code');
      }
      return 'OK';
    });

    ipcMain.on('iris:hotkey-wake', () => {
      triggerIrisWake();
    });

    ipcMain.on('iris:hide-to-background', () => {
      backgroundStealthMode = true;
      hideIrisWindow();
    });

    ipcMain.on('iris:auto-hide-after-turn', () => {
      if (backgroundStealthMode) {
        hideIrisWindow();
      }
    });

    ipcMain.on('iris:set-background-mode', (_event, enabled) => {
      backgroundStealthMode = Boolean(enabled);
      updateTrayMenu();
    });

    ipcMain.on('iris:set-dnd-mode', (_event, enabled) => {
      doNotDisturbMode = Boolean(enabled);
      updateTrayMenu();
    });

    ipcMain.on('iris:set-compact-state', (_event, state) => {
      isCompactState = Boolean(state?.isCompact);
      hasSpotifyCompact = Boolean(state?.hasSpotify);
    });

    ipcMain.on('iris:resize-window', (_event, { width, height }) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenWidth } = primaryDisplay.workAreaSize;
      const centerX = Math.round((screenWidth - width) / 2);

      let targetX = centerX;
      if (doNotDisturbMode && isCompactState) {
        targetX = Math.round(currentWinX ?? centerX);
      } else {
        currentWinX = centerX;
        targetX = centerX;
      }

      mainWindow.setBounds({ x: targetX, y: 0, width, height }, true);
    });
  });

function startDndMouseDodgeLoop() {
  if (dndDodgeInterval) clearInterval(dndDodgeInterval);
  dndDodgeInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth } = primaryDisplay.workAreaSize;
    const winBounds = mainWindow.getBounds();
    const winWidth = winBounds.width;
    const centerX = Math.round((screenWidth - winWidth) / 2);
    const leftX = Math.max(16, Math.round(screenWidth * 0.22 - winWidth / 2));
    const rightX = Math.min(screenWidth - winWidth - 16, Math.round(screenWidth * 0.78 - winWidth / 2));
    const slots = { left: leftX, center: centerX, right: rightX };

    if (currentWinX === null) {
      currentWinX = winBounds.x;
      targetWinX = slots.center;
    }

    if (!doNotDisturbMode || !isCompactState) {
      currentSlot = 'center';
      targetWinX = slots.center;
    } else {
      const cursor = screen.getCursorScreenPoint();
      const pillWidth = hasSpotifyCompact ? 268 : 210;
      const pillHeight = 76;
      const activeSlotX = slots[currentSlot] ?? centerX;
      const pillCenterX = activeSlotX + winWidth / 2;
      const dx = cursor.x - pillCenterX;
      const thresholdX = pillWidth / 2 + 60;
      const now = Date.now();

      if (cursor.y <= pillHeight + 45 && Math.abs(dx) < thresholdX && now - lastDodgeTime > 320) {
        lastDodgeTime = now;
        if (currentSlot === 'center') {
          currentSlot = dx >= 0 ? 'left' : 'right';
        } else if (currentSlot === 'left') {
          const centerDist = Math.abs(cursor.x - (centerX + winWidth / 2));
          currentSlot = centerDist < thresholdX ? 'right' : 'center';
        } else {
          const centerDist = Math.abs(cursor.x - (centerX + winWidth / 2));
          currentSlot = centerDist < thresholdX ? 'left' : 'center';
        }
      } else if (
        currentSlot !== 'center' &&
        cursor.y > 220 &&
        now - lastDodgeTime > 2000 &&
        Math.abs(cursor.x - (centerX + winWidth / 2)) >= thresholdX
      ) {
        currentSlot = 'center';
      }
      targetWinX = slots[currentSlot];
    }

    if (Math.abs(currentWinX - targetWinX) >= 1) {
      currentWinX += (targetWinX - currentWinX) * 0.28;
      mainWindow.setPosition(Math.round(currentWinX), 0, false);
    }
  }, 25);
}

  app.on('before-quit', () => {
    app.isQuitting = true;
  });

  app.on('will-quit', () => {
    if (dndDodgeInterval) {
      clearInterval(dndDodgeInterval);
      dndDodgeInterval = null;
    }
    globalShortcut.unregisterAll();
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
    }
    if (sttPythonProcess) {
      try {
        sttPythonProcess.kill();
      } catch {
        // ignore
      }
    }
    try {
      if (fs.existsSync(INSTANCE_LOCK_PATH)) {
        const cur = JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, 'utf8'));
        if (cur?.electronPid === process.pid) {
          fs.unlinkSync(INSTANCE_LOCK_PATH);
        }
      }
    } catch {
      // ignore cleanup error
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && app.isQuitting) app.quit();
  });
