/**
 * I.R.I.S. Spotify Web API Integration (OAuth 2.0 Authorization Code + PKCE)
 * ---------------------------------------------------------------------------
 * - No Client Secret needed: only the Client ID of the user's own Spotify Developer app
 * - Local loopback callback server on http://127.0.0.1:8888/callback
 * - Tokens persisted in config/spotify.json and auto-refreshed
 * - Search (track / playlist / artist / album) + direct playback on the user's device
 * - Playback control endpoints require Spotify Premium
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');
const { shell } = require('electron');

const SPOTIFY_CONFIG_PATH = path.join(__dirname, '../../config/spotify.json');
const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'playlist-read-private',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-library-read',
  'user-library-modify'
].join(' ');

let authServer = null;

function loadSpotifyConfig() {
  try {
    if (fs.existsSync(SPOTIFY_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(SPOTIFY_CONFIG_PATH, 'utf8'));
    }
  } catch {
    // ignore
  }
  return { clientId: '', accessToken: '', refreshToken: '', expiresAt: 0, userName: '' };
}

function saveSpotifyConfig(cfg) {
  fs.mkdirSync(path.dirname(SPOTIFY_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(SPOTIFY_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isConnected() {
  const cfg = loadSpotifyConfig();
  return Boolean(cfg.clientId && cfg.refreshToken);
}

function getStatus() {
  const cfg = loadSpotifyConfig();
  return {
    connected: Boolean(cfg.clientId && cfg.refreshToken),
    clientId: cfg.clientId || '',
    userName: cfg.userName || '',
    redirectUri: REDIRECT_URI
  };
}

function disconnect() {
  const cfg = loadSpotifyConfig();
  saveSpotifyConfig({ clientId: cfg.clientId, accessToken: '', refreshToken: '', expiresAt: 0, userName: '' });
  return getStatus();
}

/**
 * Starts the PKCE login flow: opens the Spotify consent page in the browser and
 * waits for the redirect on the local loopback server.
 */
function connect(clientId) {
  const cleanId = String(clientId || '').trim();
  if (!/^[a-zA-Z0-9]{32}$/.test(cleanId)) {
    return Promise.resolve({ ok: false, error: 'El Client ID debe tener 32 caracteres alfanuméricos.' });
  }

  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64Url(crypto.randomBytes(16));

  if (authServer) {
    try {
      authServer.close();
    } catch {
      // ignore
    }
    authServer = null;
  }

  return new Promise((resolve) => {
    const finish = (result) => {
      setTimeout(() => {
        try {
          authServer?.close();
        } catch {
          // ignore
        }
        authServer = null;
      }, 300);
      resolve(result);
    };

    authServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');

      const page = (msg) =>
        `<html><body style="background:#1e1d1d;color:#fff;font-family:Inter,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="margin:0 0 8px">I.R.I.S.</h2><p style="color:#b5b2ad">${msg}</p></div></body></html>`;

      if (err || !code || returnedState !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('No se pudo conectar Spotify. Puedes cerrar esta pestaña.'));
        finish({ ok: false, error: err || 'Autorización cancelada.' });
        return;
      }

      try {
        const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: cleanId,
            code_verifier: verifier
          })
        });
        const data = await tokenRes.json();
        if (!tokenRes.ok || !data.access_token) {
          throw new Error(data.error_description || data.error || 'Token inválido');
        }

        const cfg = {
          clientId: cleanId,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + (data.expires_in - 60) * 1000,
          userName: ''
        };

        try {
          const meRes = await fetch('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${data.access_token}` }
          });
          if (meRes.ok) {
            const me = await meRes.json();
            cfg.userName = me.display_name || me.id || '';
            cfg.product = me.product || '';
          }
        } catch {
          // ignore
        }

        saveSpotifyConfig(cfg);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Spotify conectado con Iris. Ya puedes cerrar esta pestaña.'));
        finish({ ok: true, status: getStatus() });
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page(`Error al conectar: ${String(e.message)}`));
        finish({ ok: false, error: String(e.message) });
      }
    });

    authServer.on('error', (e) => finish({ ok: false, error: `Puerto ${REDIRECT_PORT} ocupado: ${e.message}` }));

    authServer.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const authUrl =
        'https://accounts.spotify.com/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: cleanId,
          scope: SCOPES,
          redirect_uri: REDIRECT_URI,
          code_challenge_method: 'S256',
          code_challenge: challenge,
          state
        }).toString();
      shell.openExternal(authUrl);
    });

    // Give up after 3 minutes
    setTimeout(() => finish({ ok: false, error: 'Tiempo de espera agotado.' }), 180000);
  });
}

async function getAccessToken() {
  const cfg = loadSpotifyConfig();
  if (!cfg.clientId || !cfg.refreshToken) throw new Error('SPOTIFY_NOT_CONNECTED');
  if (cfg.accessToken && Date.now() < cfg.expiresAt) return cfg.accessToken;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.refreshToken,
      client_id: cfg.clientId
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('SPOTIFY_REFRESH_FAILED');
  }
  cfg.accessToken = data.access_token;
  if (data.refresh_token) cfg.refreshToken = data.refresh_token;
  cfg.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  saveSpotifyConfig(cfg);
  return cfg.accessToken;
}

async function spotifyRequest(method, endpoint, body = null) {
  const token = await getAccessToken();
  const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

async function search(query, type = 'track') {
  const safeType = ['track', 'playlist', 'artist', 'album'].includes(type) ? type : 'track';
  const { ok, data } = await spotifyRequest(
    'GET',
    `/search?q=${encodeURIComponent(query)}&type=${safeType}&limit=5`
  );
  if (!ok) return [];
  const items = (data?.[`${safeType}s`]?.items || []).filter(Boolean);
  return items.map((it) => ({
    type: safeType,
    id: it.id,
    uri: it.uri,
    name: it.name,
    subtitle:
      safeType === 'track' || safeType === 'album'
        ? (it.artists || []).map((a) => a.name).join(', ')
        : safeType === 'playlist'
          ? it.owner?.display_name || ''
          : 'Artista'
  }));
}

/**
 * Picks the best playback device: active one, then this PC, then anything available.
 * If none, launches Spotify Desktop and waits for it to register as a device.
 */
async function ensureDevice() {
  const pick = async () => {
    const { ok, data } = await spotifyRequest('GET', '/me/player/devices');
    if (!ok) return null;
    const devices = data?.devices || [];
    return (
      devices.find((d) => d.is_active) ||
      devices.find((d) => d.type === 'Computer') ||
      devices[0] ||
      null
    );
  };

  let device = await pick();
  if (device) return device;

  exec('start "" "spotify:"');
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 800));
    device = await pick();
    if (device) return device;
  }
  return null;
}

/**
 * Plays a Spotify item (track URI or context URI for playlist/artist/album).
 * Verifies that playback actually started so we NEVER lie to the user if the desktop app was asleep!
 */
async function playItem(item) {
  const device = await ensureDevice();
  if (!device) {
    return { ok: false, error: 'NO_DEVICE' };
  }

  // 1. If device is inactive, transfer playback to wake up Spotify Connect on that device
  if (!device.is_active) {
    try {
      await spotifyRequest('PUT', '/me/player', { device_ids: [device.id], play: true });
      await new Promise((r) => setTimeout(r, 400));
    } catch {
      // continue
    }
  }

  // 2. Send play command
  const body = item.type === 'track' ? { uris: [item.uri] } : { context_uri: item.uri };
  const res = await spotifyRequest('PUT', `/me/player/play?device_id=${device.id}`, body);

  if (res.status === 403) {
    return { ok: false, error: 'PREMIUM_REQUIRED' };
  }

  if (res.ok || res.status === 204) {
    // 3. Double-check if Spotify desktop actually woke up and is playing audio
    await new Promise((r) => setTimeout(r, 650));
    const check = await spotifyRequest('GET', '/me/player');
    if (check.ok && check.data && check.data.is_playing) {
      return { ok: true, device: check.data.device?.name || device.name, playing: true };
    }

    // Server accepted (204) but desktop client was asleep/idle
    return { ok: false, error: 'DESKTOP_ASLEEP', device: device.name, uri: item.uri };
  }

  return { ok: false, error: res.data?.error?.message || `HTTP ${res.status}` };
}

let cachedVolumePercent = null;
let cachedVolumeTimestamp = 0;

function extractTrackInfo(item, progressMs = 0) {
  const artistName = (item?.artists || []).map((a) => a.name).join(', ');
  const images = item?.album?.images || [];
  const preferredImage = images.find((img) => img.width >= 200 && img.width <= 400) || images[0];
  const trackId = item?.id || '';
  const uri = item?.uri || (trackId ? `spotify:track:${trackId}` : '');
  return {
    trackId,
    trackName: item?.name || '',
    artistName,
    albumName: item?.album?.name || '',
    albumArtUrl: preferredImage?.url || '',
    progressMs: Number(progressMs) || 0,
    durationMs: Number(item?.duration_ms) || 0,
    uri,
    externalUrl: item?.external_urls?.spotify || ''
  };
}

async function getNowPlaying() {
  if (!isConnected()) {
    return { ok: false, error: 'SPOTIFY_NOT_CONNECTED' };
  }
  const cfg = loadSpotifyConfig();
  const res = await spotifyRequest('GET', '/me/player');
  if (res.ok && res.data && res.data.item) {
    const isPlaying = Boolean(res.data.is_playing);
    const trackInfo = extractTrackInfo(res.data.item, res.data.progress_ms);
    const vol = res.data.device?.volume_percent;
    if (typeof vol === 'number' && !Number.isNaN(vol)) {
      cachedVolumePercent = vol;
      cachedVolumeTimestamp = Date.now();
    }
    const prevUri = cfg.lastTrack?.uri;
    const prevPausedDiff = !isPlaying && Math.abs((cfg.lastTrack?.progressMs || 0) - trackInfo.progressMs) > 2000;
    if (prevUri !== trackInfo.uri || prevPausedDiff || !cfg.lastTrack?.trackName) {
      cfg.lastTrack = trackInfo;
      saveSpotifyConfig(cfg);
    }
    return {
      ok: true,
      isPlaying,
      ...trackInfo,
      deviceName: res.data.device?.name || 'Spotify',
      volumePercent: vol ?? cachedVolumePercent ?? 50
    };
  }

  if (!cfg.lastTrack?.trackName) {
    const recent = await spotifyRequest('GET', '/me/player/recently-played?limit=1');
    const recentTrack = recent.ok ? recent.data?.items?.[0]?.track : null;
    if (recentTrack) {
      cfg.lastTrack = extractTrackInfo(recentTrack, 0);
      saveSpotifyConfig(cfg);
    }
  }

  if (cfg.lastTrack?.trackName) {
    return {
      ok: true,
      isPlaying: false,
      ...cfg.lastTrack,
      deviceName: 'Spotify (En pausa)',
      volumePercent: cachedVolumePercent ?? 50
    };
  }

  return {
    ok: true,
    isPlaying: false,
    trackId: '',
    trackName: 'Spotify',
    artistName: 'Pulsa Play para reproducir',
    albumName: '',
    albumArtUrl: '',
    progressMs: 0,
    durationMs: 0,
    deviceName: 'Spotify',
    volumePercent: cachedVolumePercent ?? 50,
    uri: '',
    externalUrl: ''
  };
}

async function control(subCommand, volumePercent = null) {
  const map = {
    play_pause: null,
    next: ['POST', '/me/player/next'],
    prev: ['POST', '/me/player/previous'],
    previous: ['POST', '/me/player/previous'],
    pause: ['PUT', '/me/player/pause'],
    resume: ['PUT', '/me/player/play']
  };

  if (subCommand === 'play_pause') {
    const state = await spotifyRequest('GET', '/me/player');
    if (state.ok && state.data?.is_playing) {
      const res = await spotifyRequest('PUT', '/me/player/pause');
      return res.ok || res.status === 204;
    }
    if (state.ok && state.data) {
      const res = await spotifyRequest('PUT', '/me/player/play');
      if (res.ok || res.status === 204) return true;
    }
    const cfg = loadSpotifyConfig();
    if (cfg.lastTrack?.uri) {
      const playRes = await playItem({
        uri: cfg.lastTrack.uri,
        type: 'track',
        id: cfg.lastTrack.trackId,
        name: cfg.lastTrack.trackName
      });
      if (playRes.ok) return true;
      if (playRes.error === 'DESKTOP_ASLEEP' || playRes.error === 'NO_DEVICE') {
        return { wakeUri: cfg.lastTrack.uri };
      }
    }
    return false;
  }

  if (subCommand === 'set_volume' && typeof volumePercent === 'number' && !Number.isNaN(volumePercent)) {
    const clamped = Math.max(0, Math.min(100, Math.round(volumePercent)));
    const res = await spotifyRequest('PUT', `/me/player/volume?volume_percent=${clamped}`);
    if (res.ok || res.status === 204) {
      cachedVolumePercent = clamped;
      cachedVolumeTimestamp = Date.now();
      return true;
    }
    return false;
  }

  if (subCommand === 'vol_up' || subCommand === 'vol_down') {
    let current = null;
    if (cachedVolumePercent !== null && Date.now() - cachedVolumeTimestamp < 60000) {
      current = cachedVolumePercent;
    } else {
      const state = await spotifyRequest('GET', '/me/player');
      current = state.data?.device?.volume_percent ?? 50;
    }
    const next = Math.max(0, Math.min(100, current + (subCommand === 'vol_up' ? 15 : -15)));
    const res = await spotifyRequest('PUT', `/me/player/volume?volume_percent=${next}`);
    if (res.ok || res.status === 204) {
      cachedVolumePercent = next;
      cachedVolumeTimestamp = Date.now();
      return true;
    }
    return false;
  }

  const entry = map[subCommand];
  if (!entry) return false;
  const res = await spotifyRequest(entry[0], entry[1]);
  return res.ok || res.status === 204;
}

async function seek(positionMs) {
  if (!isConnected()) return { ok: false, error: 'SPOTIFY_NOT_CONNECTED' };
  const pos = Math.max(0, Math.round(Number(positionMs) || 0));
  const res = await spotifyRequest('PUT', `/me/player/seek?position_ms=${pos}`);
  const cfg = loadSpotifyConfig();
  if (cfg.lastTrack) {
    cfg.lastTrack.progressMs = pos;
    saveSpotifyConfig(cfg);
  }
  return { ok: res.ok || res.status === 204 };
}

async function getUserPlaylists() {
  if (!isConnected()) return { ok: false, playlists: [] };
  const res = await spotifyRequest('GET', '/me/playlists?limit=25');
  const items = (res.data?.items || []).map((p) => ({
    id: p.id,
    name: p.name || 'Playlist',
    tracksTotal: p.tracks?.total || 0
  }));
  return {
    ok: true,
    playlists: [{ id: 'liked', name: '♥ Canciones que te gustan' }, ...items]
  };
}

async function addTrackToPlaylist(playlistId, trackUri = '', trackId = '') {
  if (!isConnected()) return { ok: false, error: 'SPOTIFY_NOT_CONNECTED' };
  const cfg = loadSpotifyConfig();
  const uri = trackUri || cfg.lastTrack?.uri || '';
  const id = trackId || cfg.lastTrack?.trackId || (uri.startsWith('spotify:track:') ? uri.split(':')[2] : '');
  if (!uri && !id) {
    return { ok: false, error: 'NO_TRACK' };
  }
  if (playlistId === 'liked' && id) {
    const res = await spotifyRequest('PUT', `/me/tracks?ids=${encodeURIComponent(id)}`);
    if (res.ok || res.status === 200 || res.status === 204) return { ok: true };
    if (res.status === 403) return { ok: false, error: 'INSUFFICIENT_SCOPE' };
    return { ok: false, error: res.data?.error?.message || `HTTP ${res.status}` };
  }
  const fullUri = uri || `spotify:track:${id}`;
  const res = await spotifyRequest('POST', `/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    uris: [fullUri]
  });
  if (res.ok || res.status === 201 || res.status === 200) return { ok: true };
  if (res.status === 403) return { ok: false, error: 'INSUFFICIENT_SCOPE' };
  return { ok: false, error: res.data?.error?.message || `HTTP ${res.status}` };
}

module.exports = {
  REDIRECT_URI,
  connect,
  disconnect,
  getStatus,
  isConnected,
  search,
  playItem,
  control,
  getNowPlaying,
  seek,
  getUserPlaylists,
  addTrackToPlaylist
};
