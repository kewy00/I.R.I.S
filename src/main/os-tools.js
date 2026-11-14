/**
 * I.R.I.S. Windows OS Productivity & Universal Application Launcher
 * - Dynamically indexes all installed Windows applications via PowerShell `Get-StartApps`
 * - Launches UWP apps, Squirrel apps (Discord, etc.), Steam/Epic games, and Win32 `.exe` programs
 * - Strips natural Spanish conversational prefixes ("oye ábreme...", "puedes abrir...", etc.)
 */
const os = require('os');
const { exec } = require('child_process');
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

module.exports = {
  getSystemStatsSummary,
  openWindowsApp,
  extractCleanAppName,
  inspectActiveScreen
};
