/**
 * I.R.I.S. Autonomous Windows Agent Executor ("Se busca la vida")
 * ---------------------------------------------------------------------------
 * Gives Iris real agency on Windows so she NEVER hallucinates actions:
 * - Cleans natural Spanish voice prompts ("oye reprodúceme la de Jesús walks" -> "Jesús walks")
 * - Supports Songs (`track`), Playlists (`playlist`), Artists (`artist`), and Albums (`album`)
 * - Resolves exact `spotify:<type>:<ID>` URI so Spotify Desktop selects the item directly
 * - Temporarily releases Iris's `Ctrl+Space` global shortcut and sends hardware `Ctrl + Espacio`
 *   to Spotify Desktop so the selected song/playlist/artist starts playing immediately!
 */

const { exec } = require('child_process');
const { globalShortcut, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const spotifyApi = require('./spotify-api');

function runPowerShellHidden(psScript, callback) {
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  exec(`powershell -NoProfile -WindowStyle Hidden -EncodedCommand ${encoded}`, () => {
    if (callback) callback();
  });
}

/**
 * Sends native Windows Media / Volume keys via Win32 keybd_event (0xB3 = Play/Pause, 0xB0 = Next, etc.)
 */
function sendWindowsMediaKey(keyCode, count = 1) {
  const safeCount = Math.max(1, Math.min(15, Number(count) || 1));
  return new Promise((resolve) => {
    const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinMediaKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
for ($i = 0; $i -lt ${safeCount}; $i++) {
  [WinMediaKey]::keybd_event([byte]${keyCode}, 0, 0, [UIntPtr]::Zero)
  [WinMediaKey]::keybd_event([byte]${keyCode}, 0, 2, [UIntPtr]::Zero)
}
`;
    runPowerShellHidden(ps, () => resolve(true));
  });
}

/**
 * Checks if Spotify desktop app is installed on this Windows PC
 */
function isSpotifyInstalled() {
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const paths = [
    path.join(appData, 'Spotify', 'Spotify.exe'),
    path.join(localAppData, 'Microsoft', 'WindowsApps', 'Spotify.exe')
  ];
  return paths.some((p) => fs.existsSync(p));
}

/**
 * Detects whether the user asked for a playlist, album, artist, or track
 */
function detectSpotifyEntityType(rawQuery) {
  const q = String(rawQuery || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (q.includes('playlist') || q.includes('lista de reproduccion') || q.includes('lista de ')) {
    return 'playlist';
  }
  if (q.includes('album') || q.includes('disco ')) {
    return 'album';
  }
  if (q.includes('el artista ') || q.includes('al artista ')) {
    return 'artist';
  }
  return 'track';
}

/**
 * Strips all conversational Spanish prefixes/suffixes so only the song/playlist/artist remains.
 * Example: "oye reprodúceme la de Jesús walks" -> "Jesús walks"
 */
function extractCleanSongQuery(rawQuery) {
  let q = String(rawQuery || '').trim();
  q = q.replace(/^[¿¡.,;:!?"'\s]+|[.,;:!?"'\s]+$/g, '');

  const prefixPatterns = [
    /^(?:oye|hola|ey|hey|buenas|iris|por\s+favor|porfa|vale|venga|si|sí|claro|ok|bueno)[,\s]+/i,
    /^(?:me\s+puedes|me\s+podr[ií]as|puedes|podr[ií]as|quiero\s+que\s+me|quiero\s+que|quiero|me\s+gustar[ií]a|intenta)\s+/i,
    /^(?:reprod[uú]ceme|reproducirme|reproduce|reproducir|p[oó]nme|ponerme|pon|poner|escuchar|escuchemos|que\s+suene|suene|toca|tocar|b[uú]scame|buscar|busca|abre|abrir)\s+/i,
    /^(?:alguna\s+canci[oó]n\s+de|una\s+canci[oó]n\s+de|la\s+canci[oó]n\s+de|la\s+canci[oó]n|canciones\s+de|alguna\s+playlist\s+de|una\s+playlist\s+de|la\s+playlist\s+de|la\s+playlist|playlist\s+de|el\s+[aá]lbum\s+de|el\s+[aá]lbum|el\s+disco\s+de|al\s+artista|el\s+artista|alg[uú]n\s+tema\s+de|un\s+tema\s+de|el\s+tema\s+de|el\s+tema|m[uú]sica\s+de|algo\s+de|la\s+de|el\s+de)\s+/i
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

  q = q
    .replace(/\s+(?:en\s+spotify|en\s+youtube|por\s+favor|porfa|ahora\s+mismo|ahora|ya)$/i, '')
    .trim();

  return q || String(rawQuery || '').trim();
}

/**
 * Resolves canonical song title + artist using iTunes Search API (fast, free, no API key)
 */
async function resolveCanonicalSong(cleanQuery) {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&entity=song&limit=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const item = data?.results?.[0];
    if (item && item.trackName && item.artistName) {
      return {
        trackName: item.trackName,
        artistName: item.artistName,
        displayTitle: `${item.trackName} — ${item.artistName}`,
        searchString: `${item.trackName} ${item.artistName}`
      };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Finds the exact 22-char Spotify ID (`spotify:<entityType>:<ID>`) for track, playlist, artist, or album
 */
async function findSpotifyEntityId(searchString, entityType = 'track') {
  const safeType = ['track', 'playlist', 'artist', 'album'].includes(entityType)
    ? entityType
    : 'track';

  const entityRegex = new RegExp(
    `open\\.spotify\\.com(?:\\/|%2F)(?:intl-[a-z-]+(?:\\/|%2F))?${safeType}(?:\\/|%2F)([a-zA-Z0-9]{22})`,
    'i'
  );

  const searchUrls = [
    `https://search.yahoo.com/search?p=${encodeURIComponent(`site:open.spotify.com/${safeType} ` + searchString)}`,
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:open.spotify.com/${safeType} ` + searchString)}`
  ];

  for (const url of searchUrls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      });
      if (!res.ok) continue;
      const html = await res.text();
      const match = html.match(entityRegex);
      if (match && match[1]) {
        return match[1];
      }
    } catch {
      // try next engine
    }
  }
  return null;
}

/**
 * Finds the first YouTube video ID for a song/query so it can autoplay immediately
 */
async function findYouTubeVideoId(query) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Opens the Spotify URI (`spotify:track:<ID>`, `spotify:playlist:<ID>`, `spotify:artist:<ID>`)
 * so the item is selected in Spotify Desktop, temporarily unregisters Iris's `Ctrl+Space` global shortcut,
 * and sends `Ctrl + Espacio` (`VK_CONTROL` + `VK_SPACE`) to Spotify to play the selected item!
 */
function blurAllIrisWindows() {
  try {
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      if (!win.isDestroyed()) {
        win.blur();
        win.webContents?.executeJavaScript('document.activeElement?.blur?.()').catch(() => {});
      }
    }
  } catch {
    // ignore
  }
}

function launchSpotifyWithCtrlSpace(spotifyUri) {
  // 1. Temporarily release Iris's global Ctrl+Space hook so Windows passes Ctrl+Space to Spotify
  try {
    if (globalShortcut && globalShortcut.isRegistered('CommandOrControl+Space')) {
      globalShortcut.unregister('CommandOrControl+Space');
    }
  } catch {
    // ignore
  }

  // 2. Yield focus from Iris HUD to Spotify so Iris does NOT swallow the Ctrl+Space event!
  if (typeof global.yieldFocusToSpotify === 'function') {
    global.yieldFocusToSpotify();
  }
  blurAllIrisWindows();

  // 3. Open the exact Spotify URI — Windows brings Spotify to front and selects the song row
  exec(`start "" "${spotifyUri}"`);

  // 4. PowerShell script:
  //    - Sends genuine hardware Ctrl+Space (VK_CONTROL 0x11 scan 0x1D + VK_SPACE 0x20 scan 0x39)
  //    - Also sends .NET Forms SendKeys "^{SPACE}"
  //    - Also sends hardware Media Play/Pause (0xB3)
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinSpotKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

Start-Sleep -Milliseconds 1900

# 1. Hardware Ctrl + Space
[WinSpotKey]::keybd_event(0x11, 0x1D, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[WinSpotKey]::keybd_event(0x20, 0x39, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[WinSpotKey]::keybd_event(0x20, 0x39, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[WinSpotKey]::keybd_event(0x11, 0x1D, 2, [UIntPtr]::Zero)

# 2. Forms SendKeys Ctrl+Space
try {
  [System.Windows.Forms.SendKeys]::SendWait("^{SPACE}")
} catch {}

# 3. Hardware Media Play key
Start-Sleep -Milliseconds 180
[WinSpotKey]::keybd_event(0xB3, 0, 0, [UIntPtr]::Zero)
[WinSpotKey]::keybd_event(0xB3, 0, 2, [UIntPtr]::Zero)
`;

  runPowerShellHidden(psScript, () => {
    setTimeout(() => {
      if (typeof global.restoreIrisFocus === 'function') {
        global.restoreIrisFocus();
      }
      if (typeof global.rebindIrisShortcuts === 'function') {
        global.rebindIrisShortcuts();
      }
    }, 400);
  });
}

/**
 * Autonomously plays a song, playlist, artist, or album on the user's PC
 */
async function playViaSpotifyApi(rawQuery, explicitEntityType = null) {
  const entityType =
    ['track', 'playlist', 'artist', 'album'].includes(explicitEntityType)
      ? explicitEntityType
      : detectSpotifyEntityType(rawQuery);
  const cleanQuery = extractCleanSongQuery(rawQuery);
  const results = await spotifyApi.search(cleanQuery, entityType);
  if (results.length === 0) {
    return {
      handled: true,
      reply: `No he encontrado "${cleanQuery}" en Spotify.`,
      artifact: null
    };
  }

  const top = results[0];
  const playRes = await spotifyApi.playItem(top);
  const title = top.subtitle ? `${top.name} — ${top.subtitle}` : top.name;

  // Clickable alternatives (other search results) in the Artifact
  const items = results.slice(0, 5).map((r) => ({
    label: r.subtitle ? `${r.name} — ${r.subtitle}` : r.name,
    actionType: 'spotify_play',
    spotifyItem: r
  }));

  if (playRes.ok) {
    return {
      handled: true,
      reply: `Reproduciendo "${title}" en Spotify.`,
      artifact: null
    };
  }

  // If the desktop app was in cold-start/idle and didn't stream over Connect,
  // wake it up immediately by opening the track in Spotify Desktop + sending Ctrl+Space!
  if (playRes.error === 'DESKTOP_ASLEEP' || playRes.error === 'NO_DEVICE') {
    launchSpotifyWithCtrlSpace(top.uri);
    return {
      handled: true,
      reply: `Poniendo "${title}" en Spotify.`,
      artifact: null
    };
  }

  if (playRes.error === 'PREMIUM_REQUIRED') {
    // API search worked but playback control needs Premium: open the exact item instead
    exec(`start "" "${top.uri}"`);
    return {
      handled: true,
      reply: `He abierto "${title}" en Spotify, pero controlar la reproducción por API requiere Spotify Premium.`,
      artifact: { type: 'media', badge: 'Spotify', title, subtitle: 'Pulsa play en Spotify', items }
    };
  }

  if (playRes.error === 'NO_DEVICE') {
    return {
      handled: true,
      reply: 'He abierto Spotify pero no aparece como dispositivo todavía. Dale un segundo y vuelve a pedírmelo.',
      artifact: null
    };
  }

  return { handled: false };
}

async function playMusicOrVideo(rawQuery, forcePlatform = null, explicitEntityType = null) {
  // Preferred path: official Spotify Web API (no simulated keystrokes)
  if (forcePlatform !== 'youtube' && spotifyApi.isConnected()) {
    try {
      const apiRes = await playViaSpotifyApi(rawQuery, explicitEntityType);
      if (apiRes.handled) {
        return { executed: true, reply: apiRes.reply, artifact: apiRes.artifact };
      }
    } catch (e) {
      console.warn('[IRIS Spotify API] Falling back to desktop automation:', e.message);
    }
  }

  const entityType =
    ['track', 'playlist', 'artist', 'album'].includes(explicitEntityType)
      ? explicitEntityType
      : detectSpotifyEntityType(rawQuery);
  const cleanQuery = extractCleanSongQuery(rawQuery);

  let searchTarget = cleanQuery;
  let displayTitle = cleanQuery;

  // For songs/tracks, enrich with canonical Track + Artist via iTunes
  if (entityType === 'track') {
    const canonical = await resolveCanonicalSong(cleanQuery);
    if (canonical) {
      searchTarget = canonical.searchString;
      displayTitle = canonical.displayTitle;
    }
  }

  const hasSpotify = isSpotifyInstalled();

  // Resolve exact Spotify Entity ID and YouTube Video ID in parallel
  const [spotifyEntityId, youtubeVideoId] = await Promise.all([
    findSpotifyEntityId(searchTarget, entityType),
    findYouTubeVideoId(searchTarget)
  ]);

  const youtubePlayUrl = youtubeVideoId
    ? `https://www.youtube.com/watch?v=${youtubeVideoId}&autoplay=1`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(searchTarget)}`;

  const spotifyPlayUri = spotifyEntityId
    ? `spotify:${entityType}:${spotifyEntityId}`
    : `spotify:search:${encodeURIComponent(searchTarget)}`;

  const useSpotify = forcePlatform === 'spotify' || (forcePlatform !== 'youtube' && hasSpotify);

  if (useSpotify) {
    launchSpotifyWithCtrlSpace(spotifyPlayUri, spotifyEntityId ? entityType : 'search');
  } else {
    exec(`start "" "${youtubePlayUrl}"`);
  }

  return {
    executed: true,
    reply: useSpotify
      ? `Seleccionando y reproduciendo "${displayTitle}" en Spotify con Ctrl+Espacio.`
      : `Reproduciendo "${displayTitle}" directamente en YouTube.`,
    artifact: null
  };
}

/**
 * Controls Windows system media or volume
 */
async function executeMediaControl(subCommand, volumePercent = null) {
  const spotifyCmds = ['play_pause', 'pause', 'resume', 'next', 'prev', 'previous', 'vol_up', 'vol_down', 'set_volume'];
  if (spotifyApi.isConnected() && spotifyCmds.includes(subCommand)) {
    try {
      const ok = await Promise.race([
        spotifyApi.control(subCommand, volumePercent),
        new Promise((resolve) => setTimeout(() => resolve(false), 1200))
      ]);
      if (ok) {
        const msgs = {
          play_pause: 'Hecho, he alternado play y pausa en Spotify.',
          pause: 'He pausado la reproducción en Spotify.',
          resume: 'Reproducción reanudada en Spotify.',
          next: 'Siguiente canción en Spotify.',
          prev: 'Canción anterior en Spotify.',
          previous: 'Canción anterior en Spotify.',
          vol_up: 'He subido el volumen de Spotify.',
          vol_down: 'He bajado el volumen de Spotify.',
          set_volume: `Volumen de Spotify ajustado al ${Math.round(Number(volumePercent) || 50)}%.`
        };
        return msgs[subCommand];
      }
    } catch {
      // fall back to Windows media keys
    }
  }

  switch (subCommand) {
    case 'play_pause':
    case 'pause':
    case 'resume':
      await sendWindowsMediaKey(179, 1); // VK_MEDIA_PLAY_PAUSE
      return subCommand === 'pause'
        ? 'Reproducción pausada.'
        : subCommand === 'resume'
          ? 'Reproducción reanudada.'
          : 'Reproducción alternada (Play/Pausa).';
    case 'next':
      await sendWindowsMediaKey(176, 1); // VK_MEDIA_NEXT_TRACK
      return 'Saltando a la siguiente canción.';
    case 'prev':
    case 'previous':
      await sendWindowsMediaKey(177, 1); // VK_MEDIA_PREV_TRACK
      return 'Volviendo a la canción anterior.';
    case 'vol_up':
      await sendWindowsMediaKey(175, 4); // VK_VOLUME_UP (single PS call)
      return 'He subido el volumen del sistema.';
    case 'vol_down':
      await sendWindowsMediaKey(174, 4); // VK_VOLUME_DOWN (single PS call)
      return 'He bajado el volumen del sistema.';
    case 'mute':
      await sendWindowsMediaKey(173, 1); // VK_VOLUME_MUTE
      return 'Audio del sistema silenciado/activado.';
    default:
      return 'Comando multimedia ejecutado.';
  }
}

module.exports = {
  playMusicOrVideo,
  executeMediaControl,
  launchSpotifyWithCtrlSpace,
  extractCleanSongQuery,
  findSpotifyEntityId,
  findYouTubeVideoId
};
