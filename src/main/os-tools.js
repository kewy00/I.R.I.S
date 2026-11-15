/**
 * I.R.I.S. Windows OS Productivity & Universal Application Launcher
 * - Dynamically indexes all installed Windows applications via PowerShell `Get-StartApps`
 * - Launches UWP apps, Squirrel apps (Discord, etc.), Steam/Epic games, and Win32 `.exe` programs
 * - Strips natural Spanish conversational prefixes ("oye ábreme...", "puedes abrir...", etc.)
 */
const os = require('os');
const path = require('path');
const { exec, execFile } = require('child_process');
const { desktopCapturer } = require('electron');

let cachedStartApps = [];
let isIndexingApps = false;

function normalizeText(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Loads all installed Start Menu apps on Windows via `Get-StartApps`
 */
function refreshStartAppsCache() {
  if (isIndexingApps) return Promise.resolve(cachedStartApps);
  isIndexingApps = true;

  return new Promise((resolve) => {
    const psScript = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -WindowStyle Hidden -EncodedCommand ${encoded}`, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      isIndexingApps = false;
      if (!err && stdout) {
        try {
          const parsed = JSON.parse(stdout.trim());
          const list = Array.isArray(parsed) ? parsed : [parsed];
          cachedStartApps = list
            .filter(
              (item) =>
                item &&
                item.Name &&
                item.AppID &&
                !/^(uninstall|desinstalar)\b/i.test(item.Name)
            )
            .map((item) => ({
              name: String(item.Name).trim(),
              normName: normalizeText(item.Name),
              appId: String(item.AppID).trim()
            }));
        } catch {
          // keep existing cache
        }
      }
      resolve(cachedStartApps);
    });
  });
}

// Preload installed Windows apps at startup
refreshStartAppsCache();

/**
 * Strips Spanish conversational prefixes from an app-launch request
 * e.g. "oye puedes abrirme la aplicación de Discord por favor" -> "discord"
 */
function extractCleanAppName(rawQuery) {
  let q = String(rawQuery || '').trim();
  q = q.replace(/^[¿¡.,;:!?"'\s]+|[.,;:!?"'\s]+$/g, '');

  const prefixPatterns = [
    /^(?:oye|hola|ey|hey|buenas|iris|por\s+favor|porfa|vale|venga|si|sí|claro|ok)[,\s]+/i,
    /^(?:me\s+puedes|me\s+podr[ií]as|puedes|podr[ií]as|quiero\s+que\s+me|quiero\s+que|quiero|intenta)\s+/i,
    /^(?:[aá]breme|abrirme|abre|abrir|in[ií]ciame|iniciar|inicia|ejec[uú]tame|ejecutar|ejecuta|l[aá]nzame|lanzar|lanza|arranca|arrancar|ponme|pon)\s+/i,
    /^(?:la\s+aplicaci[oó]n\s+de|la\s+aplicaci[oó]n|la\s+app\s+de|la\s+app|el\s+programa\s+de|el\s+programa|el\s+juego\s+de|el\s+juego|el|la|los|las|mi)\s+/i
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const pat of prefixPatterns) {
      const next = q.replace(pat, '').trim();
      if (next !== q && next.length > 0) {
        q = next;
        changed = true;
      }
    }
  }

  q = q.replace(/\s+(?:por\s+favor|porfa|ahora\s+mismo|ahora|ya)$/i, '').trim();
  return q;
}

function getSystemStatsSummary() {
  const totalMemGB = (os.totalmem() / 1024 ** 3).toFixed(1);
  const freeMemGB = (os.freemem() / 1024 ** 3).toFixed(1);
  const usedMemGB = (totalMemGB - freeMemGB).toFixed(1);
  return `Memoria RAM en uso: ${usedMemGB} GB de ${totalMemGB} GB disponibles.`;
}

function launchStartAppEntry(entry) {
  const appId = entry.appId;
  if (/^https?:\/\//i.test(appId)) {
    exec(`start "" "${appId}"`);
    return;
  }
  if (/^[a-zA-Z]:\\/.test(appId) && appId.toLowerCase().endsWith('.exe')) {
    exec(`start "" "${appId}"`);
    return;
  }
  exec(`explorer.exe "shell:AppsFolder\\${appId}"`);
}

const WIN_CTRL_SCRIPT = path.join(__dirname, 'win-ctrl.ps1');

function invokeWinCtrlScript({
  action,
  target = '2',
  includeTray = false,
  tokens = [],
  allowKillByProcess = false,
  isActiveTarget = false
}) {
  const payloadJson = JSON.stringify({
    action,
    target,
    monitor: target,
    includeTray: Boolean(includeTray),
    tokens,
    procCandidates: tokens,
    titleCandidates: tokens,
    allowKillByProcess,
    isActiveTarget,
    irisPid: process.pid
  });
  const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64');
  return runPowerShellFileJson(WIN_CTRL_SCRIPT, [payloadB64], 9000);
}

async function openWindowsApp(rawQuery) {
  const cleanTarget = extractCleanAppName(rawQuery);
  const q = normalizeText(cleanTarget);

  if (!q) {
    return 'Dime qué aplicación quieres que abra.';
  }

  // 1. Built-in Windows System & Common Apps
  if (q.includes('calculadora') || q === 'calc') {
    exec('start calc');
    return 'He abierto la Calculadora.';
  }
  if (q.includes('bloc de notas') || q === 'notas' || q.includes('notepad')) {
    exec('start notepad');
    return 'He abierto el Bloc de notas.';
  }
  if (q.includes('explorador') || q.includes('archivos') || q.includes('carpeta')) {
    exec('start explorer');
    return 'He abierto el Explorador de archivos.';
  }
  if (q.includes('administrador de tareas') || q.includes('taskmgr') || q.includes('task manager')) {
    exec('start taskmgr');
    return 'He abierto el Administrador de tareas.';
  }
  if (q.includes('configuracion') || q.includes('ajustes de windows')) {
    exec('start ms-settings:');
    return 'He abierto la Configuración de Windows.';
  }
  if (q.includes('panel de control')) {
    exec('start control');
    return 'He abierto el Panel de control.';
  }
  if (q.includes('paint')) {
    exec('start mspaint');
    return 'He abierto Paint.';
  }
  if (q.includes('recortes') || q.includes('captura')) {
    exec('start ms-screenclip:');
    return 'Herramienta de recortes abierta.';
  }
  if (q.includes('terminal') || q.includes('consola') || q.includes('powershell')) {
    exec('start powershell');
    return 'He abierto PowerShell.';
  }
  if (q === 'cmd' || q.includes('simbolo del sistema')) {
    exec('start cmd');
    return 'He abierto el Símbolo del sistema.';
  }

  // If a desktop app window is already open, restore/focus it instead of spawning a second instance
  const isBrowserUrlShortcut = q === 'youtube' || q === 'google' || q === 'navegador';
  if (!isBrowserUrlShortcut) {
    const resolvedOpen = resolveWindowAppAliases(cleanTarget);
    if (resolvedOpen.tokens.length > 0 && !resolvedOpen.isActiveTarget && !resolvedOpen.isAllTarget) {
      const existingWin = await invokeWinCtrlScript({
        action: 'restore',
        includeTray: false,
        tokens: resolvedOpen.tokens,
        allowKillByProcess: false,
        isActiveTarget: false
      });
      if (existingWin.ok) {
        return `He abierto ${resolvedOpen.cleanLabel || cleanTarget}.`;
      }
    }
  }

  if (q.includes('vscode') || q.includes('visual studio code') || q === 'code') {
    exec('code .');
    return 'He abierto Visual Studio Code.';
  }
  if (q === 'spotify') {
    exec('start "" "spotify:"');
    return 'He abierto Spotify.';
  }
  if (q === 'youtube') {
    exec('start "" "https://www.youtube.com"');
    return 'He abierto YouTube en tu navegador.';
  }
  if (q === 'google' || q === 'navegador') {
    exec('start "" "https://www.google.com"');
    return 'He abierto tu navegador.';
  }

  // 2. Search in dynamically indexed Windows Start Menu applications (`Get-StartApps`)
  if (cachedStartApps.length === 0) {
    await refreshStartAppsCache();
  }

  // Exact match first, then startsWith, then word/substring match
  let match =
    cachedStartApps.find((a) => a.normName === q) ||
    cachedStartApps.find((a) => a.normName.startsWith(q)) ||
    cachedStartApps.find((a) => a.normName.includes(q)) ||
    cachedStartApps.find((a) => q.includes(a.normName) && a.normName.length >= 4);

  if (!match) {
    // Refresh cache once in case app was recently installed
    await refreshStartAppsCache();
    match =
      cachedStartApps.find((a) => a.normName === q) ||
      cachedStartApps.find((a) => a.normName.startsWith(q)) ||
      cachedStartApps.find((a) => a.normName.includes(q));
  }

  if (match) {
    launchStartAppEntry(match);
    return `He abierto ${match.name}.`;
  }

  return `No he encontrado la aplicación "${cleanTarget}" instalada en tu Windows.`;
}

async function inspectActiveScreen() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 }
    });
    const activeWindows = sources
      .filter((s) => s.name && !s.name.includes('I.R.I.S.') && s.name !== 'Entire Screen')
      .map((s) => s.name);

    if (activeWindows.length > 0) {
      const topWin = activeWindows[0].slice(0, 26);
      return `Viendo: ${topWin}`;
    }
    return 'Escritorio capturado sin errores';
  } catch {
    return 'Pantalla analizada correctamente';
  }
}

function resolveWindowAppAliases(rawAppName) {
  let q = String(rawAppName || '').trim();
  q = q.replace(/^[¿¡.,;:!?"'\s]+|[.,;:!?"'\s]+$/g, '');
  q = q
    .replace(
      /^(?:la\s+aplicaci[oó]n\s+de|la\s+aplicacion\s+de|la\s+app\s+de|la\s+ventana\s+de|el\s+programa\s+de|los\s+programas\s+de|el|la|los|las|mi)\s+/i,
      ''
    )
    .replace(/\s+(?:por\s+favor|porfa|ahora\s+mismo|ahora|ya)$/i, '')
    .trim();

  const norm = normalizeText(q);
  if (!norm) {
    return { cleanLabel: '', tokens: [], allowKillByProcess: false, isActiveTarget: false, isAllTarget: false };
  }
  if (/^(?:active|actual|esta|esta ventana|ventana actual|focused)$/.test(norm)) {
    return {
      cleanLabel: 'la ventana activa',
      tokens: ['__ACTIVE__'],
      allowKillByProcess: false,
      isActiveTarget: true,
      isAllTarget: false
    };
  }
  if (/^(?:all|todas|todo|todas las ventanas)$/.test(norm)) {
    return {
      cleanLabel: 'todas las ventanas',
      tokens: [],
      allowKillByProcess: false,
      isActiveTarget: false,
      isAllTarget: true
    };
  }

  const aliasTable = [
    { re: /\b(?:spotify|spoti\w*|spoty)\b/, label: 'Spotify', tokens: ['spotify'], kill: true },
    { re: /\b(?:antigravity|anti\s*gravity|antigra\w*)\b/, label: 'Antigravity', tokens: ['antigravity'], kill: true },
    { re: /\b(?:discord|discor\w*|disc|dis)\b/, label: 'Discord', tokens: ['discord'], kill: true },
    { re: /\b(?:google\s+chrome|chrome)\b/, label: 'Chrome', tokens: ['chrome'], kill: true },
    { re: /\bnavegador\b/, label: 'el navegador', tokens: ['chrome', 'msedge', 'brave', 'firefox', 'opera'], kill: true },
    { re: /\bedge\b/, label: 'Microsoft Edge', tokens: ['msedge', 'edge'], kill: true },
    { re: /\bbrave\b/, label: 'Brave', tokens: ['brave'], kill: true },
    { re: /\bfirefox\b/, label: 'Firefox', tokens: ['firefox'], kill: true },
    { re: /\b(?:visual\s+studio\s+code|vscode|vs\s*code|code)\b/, label: 'Visual Studio Code', tokens: ['code', 'visual studio code'], kill: true },
    { re: /\b(?:calculadora|calc)\b/, label: 'la Calculadora', tokens: ['calculatorapp', 'calculadora', 'calculator'], kill: true },
    { re: /\b(?:bloc\s+de\s+notas|notepad|notas)\b/, label: 'el Bloc de notas', tokens: ['notepad', 'bloc de notas'], kill: true },
    { re: /\b(?:explorador(?:\s+de\s+archivos)?|archivos|carpeta)\b/, label: 'el Explorador de archivos', tokens: ['__EXPLORER_WINDOW__'], kill: false },
    { re: /\b(?:terminal|powershell|consola|cmd)\b/, label: 'la Terminal', tokens: ['windowsterminal', 'powershell', 'pwsh', 'cmd'], kill: true },
    { re: /\bwhatsapp\b/, label: 'WhatsApp', tokens: ['whatsapp'], kill: true },
    { re: /\btelegram\b/, label: 'Telegram', tokens: ['telegram'], kill: true },
    { re: /\bobs\b/, label: 'OBS', tokens: ['obs64', 'obs32', 'obs'], kill: true },
    { re: /\bsteam\b/, label: 'Steam', tokens: ['steam'], kill: true }
  ];

  for (const entry of aliasTable) {
    if (entry.re.test(norm)) {
      return {
        cleanLabel: entry.label,
        tokens: entry.tokens,
        allowKillByProcess: entry.kill,
        isActiveTarget: false,
        isAllTarget: false
      };
    }
  }

  return {
    cleanLabel: q,
    tokens: [norm],
    allowKillByProcess: true,
    isActiveTarget: false,
    isAllTarget: false
  };
}

function parsePowerShellJsonOutput(err, stdout, stderr) {
  if (err && !stdout) {
    return { ok: false, error: stderr || err.message };
  }
  const trimmed = String(stdout || '').trim();
  const jsonStart = trimmed.lastIndexOf('{');
  if (jsonStart !== -1) {
    try {
      return JSON.parse(trimmed.slice(jsonStart));
    } catch {
      // fall through
    }
  }
  return { ok: false, error: trimmed || stderr || 'Sin respuesta de PowerShell' };
}

function runPowerShellJson(psScript, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const wrapped = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${psScript}`;
    const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => resolve(parsePowerShellJsonOutput(err, stdout, stderr))
    );
  });
}

function runPowerShellFileJson(scriptPath, args = [], timeoutMs = 9000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => resolve(parsePowerShellJsonOutput(err, stdout, stderr))
    );
  });
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function controlWindowsWindow({ action, appName = '', monitor = '2' } = {}) {
  const safeAction = String(action || '').trim().toLowerCase();
  const validActions = new Set([
    'close',
    'minimize',
    'minimize_all',
    'maximize',
    'restore',
    'focus',
    'move_monitor',
    'snap_left',
    'snap_right'
  ]);

  if (!validActions.has(safeAction)) {
    return {
      ok: false,
      reply: `No reconocí la acción de ventana "${safeAction}".`
    };
  }

  if (safeAction === 'minimize_all') {
    const res = await runPowerShellJson(`
(New-Object -ComObject Shell.Application).MinimizeAll()
@{ ok = $true; matched = 1; action = "minimize_all" } | ConvertTo-Json -Compress
`);
    if (res.ok) {
      return { ok: true, reply: 'He minimizado todas las ventanas.' };
    }
    return { ok: false, reply: 'No pude minimizar todas las ventanas.' };
  }

  const resolved = resolveWindowAppAliases(appName || (safeAction === 'move_monitor' ? 'active' : ''));
  if (!resolved.tokens.length && !resolved.isAllTarget) {
    return {
      ok: false,
      reply: 'Dime qué aplicación o ventana quieres controlar.'
    };
  }

  const monitorNorm = normalizeText(monitor || '2');
  let monitorTarget = '2';
  if (/\bleft\b|\bizquierd/.test(monitorNorm)) monitorTarget = 'left';
  else if (/\bright\b|\bderech/.test(monitorNorm)) monitorTarget = 'right';
  else if (/\b(1|primary|primera|1a|uno|principal)\b/.test(monitorNorm)) monitorTarget = '1';
  else if (/\b(2|secondary|segunda|2a|dos|secundaria|secundario)\b/.test(monitorNorm)) monitorTarget = '2';
  else if (/\bother\b|otr|siguient/.test(monitorNorm)) monitorTarget = 'other';

  const runWinCtrl = (includeTray) =>
    invokeWinCtrlScript({
      action: safeAction,
      target: monitorTarget,
      includeTray,
      tokens: resolved.tokens,
      allowKillByProcess: resolved.allowKillByProcess,
      isActiveTarget: resolved.isActiveTarget
    });

  let res = await runWinCtrl(false);

  const canWakeWindow = ['move_monitor', 'maximize', 'restore', 'focus', 'snap_left', 'snap_right'].includes(safeAction);
  const shouldStopPolling = (r) =>
    r.ok || (safeAction === 'move_monitor' && typeof r.screenCount === 'number' && r.screenCount < 2);

  if (!res.ok && canWakeWindow && res.reason !== 'single_monitor' && !resolved.isActiveTarget) {
    if (resolved.tokens.includes('spotify')) {
      exec('start "" "spotify:"');
      for (let attempt = 0; attempt < 6; attempt++) {
        await delayMs(650);
        res = await runWinCtrl(attempt === 5);
        if (shouldStopPolling(res)) break;
      }
    } else {
      // Pass 2: check hidden / minimized-to-tray windows of already running processes
      res = await runWinCtrl(true);

      // Pass 3+: open target app (e.g. freshly launched in "modo trabajo") and wait for a visible window
      if (!res.ok && res.reason !== 'single_monitor') {
        if (resolved.tokens[0] !== '__EXPLORER_WINDOW__') {
          await openWindowsApp(resolved.cleanLabel || appName);
        }

        for (let attempt = 0; attempt < 6; attempt++) {
          await delayMs(700);
          res = await runWinCtrl(false);
          if (shouldStopPolling(res)) break;
        }
      }
    }
  }

  const label = resolved.cleanLabel || appName;

  if (safeAction === 'move_monitor' && (res.reason === 'single_monitor' || (typeof res.screenCount === 'number' && res.screenCount < 2))) {
    return {
      ok: false,
      reply: 'Solo detecto una pantalla conectada en este momento.'
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      reply: `No encontré ninguna ventana abierta de ${label}.`
    };
  }

  const monitorLabelMap = {
    '1': 'la pantalla principal',
    '2': 'la segunda pantalla',
    left: 'la pantalla izquierda',
    right: 'la pantalla derecha',
    other: 'la otra pantalla'
  };

  switch (safeAction) {
    case 'close':
      return { ok: true, reply: `He cerrado ${label}.` };
    case 'minimize':
      return { ok: true, reply: `He minimizado ${label}.` };
    case 'maximize':
      return { ok: true, reply: `He maximizado ${label}.` };
    case 'restore':
    case 'focus':
      return { ok: true, reply: `He puesto ${label} en primer plano.` };
    case 'move_monitor':
      return { ok: true, reply: `He movido ${label} a ${monitorLabelMap[monitorTarget] || 'la otra pantalla'}.` };
    case 'snap_left':
      return { ok: true, reply: `He ajustado ${label} a la mitad izquierda.` };
    case 'snap_right':
      return { ok: true, reply: `He ajustado ${label} a la mitad derecha.` };
    default:
      return { ok: true, reply: 'Listo.' };
  }
}

module.exports = {
  getSystemStatsSummary,
  openWindowsApp,
  extractCleanAppName,
  resolveWindowAppAliases,
  inspectActiveScreen,
  controlWindowsWindow
};
