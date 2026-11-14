/**
 * I.R.I.S. Google Workspace Integration (Gmail & Google Calendar via OAuth 2.0 PKCE)
 * ---------------------------------------------------------------------------
 * - Supports OAuth 2.0 Authorization Code + PKCE for Desktop / Web clients
 * - Local loopback callback server on http://127.0.0.1:8889/google-callback
 * - Automatically refreshes access tokens using refresh_token
 * - Reads unread/recent Gmail messages with subject, sender, date, snippet, and direct link
 * - Reads upcoming Google Calendar events
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');

const GOOGLE_CONFIG_PATH = path.join(__dirname, '../../config/google.json');
const REDIRECT_PORT = 8889;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/google-callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
].join(' ');

let authServer = null;

function loadGoogleConfig() {
  try {
    if (fs.existsSync(GOOGLE_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(GOOGLE_CONFIG_PATH, 'utf8'));
    }
  } catch {
    // ignore
  }
  return {
    clientId: '493282729467-v7kgo0cvfa264rgelc11356ve7ts5v8m.apps.googleusercontent.com',
    clientSecret: '',
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    accountEmail: '',
    accountName: ''
  };
}

function saveGoogleConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(GOOGLE_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(GOOGLE_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class IrisGoogleApi {
  constructor() {
    this.config = loadGoogleConfig();
  }

  isConnected() {
    this.config = loadGoogleConfig();
    return Boolean(this.config.accessToken || this.config.refreshToken);
  }

  getStatus() {
    this.config = loadGoogleConfig();
    return {
      connected: this.isConnected(),
      clientId: this.config.clientId || '',
      clientSecret: this.config.clientSecret || '',
      accountEmail: this.config.accountEmail || '',
      accountName: this.config.accountName || '',
      redirectUri: REDIRECT_URI
    };
  }

  disconnect() {
    this.config = loadGoogleConfig();
    saveGoogleConfig({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      accountEmail: '',
      accountName: ''
    });
    return this.getStatus();
  }

  async ensureValidToken() {
    this.config = loadGoogleConfig();
    if (!this.config.accessToken && !this.config.refreshToken) {
      throw new Error('Google Workspace no está conectado.');
    }

    // If token is still valid for > 60 seconds, use it
    if (this.config.accessToken && this.config.expiresAt > Date.now() + 60000) {
      return this.config.accessToken;
    }

    if (!this.config.refreshToken) {
      if (this.config.accessToken) return this.config.accessToken;
      throw new Error('Sesión de Google expirada. Vuelve a conectar en Ajustes.');
    }

    // Refresh access token
    try {
      const bodyParams = new URLSearchParams({
        client_id: this.config.clientId,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token'
      });
      if (this.config.clientSecret) {
        bodyParams.append('client_secret', this.config.clientSecret);
      }

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: bodyParams
      });

      const data = await res.json();
      if (!res.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || 'No se pudo refrescar el token de Google');
      }

      this.config.accessToken = data.access_token;
      this.config.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      if (data.refresh_token) this.config.refreshToken = data.refresh_token;

      saveGoogleConfig(this.config);
      return this.config.accessToken;
    } catch (err) {
      throw new Error(`Error al refrescar token de Google: ${err.message}`);
    }
  }

  connect(clientId, clientSecret = '') {
    const cleanId = String(clientId || '').trim();
    const cleanSecret = String(clientSecret || '').trim();

    if (!cleanId || !cleanId.includes('.apps.googleusercontent.com')) {
      return Promise.resolve({
        ok: false,
        error: 'El Client ID de Google debe tener el formato "...apps.googleusercontent.com".'
      });
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
        }, 500);
        resolve(result);
      };

      authServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, REDIRECT_URI);
        if (url.pathname !== '/google-callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        const returnedState = url.searchParams.get('state');

        const page = (title, msg) => `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>I.R.I.S. - Google Workspace</title>
              <style>
                body {
                  background: #1e1d1d;
                  color: #ffffff;
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  height: 100vh;
                  margin: 0;
                }
                .card {
                  background: #252424;
                  border: 1px solid #383636;
                  border-radius: 16px;
                  padding: 28px 36px;
                  text-align: center;
                  max-width: 420px;
                }
                h2 { margin: 0 0 10px; font-size: 20px; font-weight: 600; color: #f4f3f0; }
                p { margin: 0; font-size: 13.5px; color: #b5b2ad; line-height: 1.5; }
              </style>
            </head>
            <body>
              <div class="card">
                <h2>${title}</h2>
                <p>${msg}</p>
              </div>
            </body>
          </html>
        `;

        if (err || !code || returnedState !== state) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(page('Autorización no completada', 'No se ha podido vincular la cuenta de Google. Puedes cerrar esta ventana.'));
          finish({ ok: false, error: err || 'Autorización cancelada por el usuario.' });
          return;
        }

        try {
          const bodyParams = new URLSearchParams({
            client_id: cleanId,
            code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI
          });
          if (cleanSecret) {
            bodyParams.append('client_secret', cleanSecret);
          }

          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: bodyParams
          });

          const data = await tokenRes.json();
          if (!tokenRes.ok || !data.access_token) {
            const errDesc = data.error_description || data.error || 'Token inválido';
            throw new Error(errDesc);
          }

          const newConfig = {
            clientId: cleanId,
            clientSecret: cleanSecret,
            accessToken: data.access_token,
            refreshToken: data.refresh_token || '',
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
            accountEmail: '',
            accountName: ''
          };

          // Fetch user profile info
          try {
            const meRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
              headers: { Authorization: `Bearer ${data.access_token}` }
            });
            if (meRes.ok) {
              const me = await meRes.json();
              newConfig.accountEmail = me.email || '';
              newConfig.accountName = me.name || me.email || '';
            }
          } catch {
            // ignore
          }

          saveGoogleConfig(newConfig);
          this.config = newConfig;

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            page(
              '¡Google Workspace Conectado!',
              `Cuenta vinculada correctamente: <b>${newConfig.accountEmail || 'Google'}</b>.<br>Ya puedes cerrar esta pestaña y volver a I.R.I.S.`
            )
          );
          finish({ ok: true, status: this.getStatus() });
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(page('Error al conectar', `Error: ${e.message}`));
          finish({ ok: false, error: e.message });
        }
      });

      authServer.on('error', (err) => {
        finish({ ok: false, error: `Error en el servidor local de autenticación: ${err.message}` });
      });

      authServer.listen(REDIRECT_PORT, '127.0.0.1', () => {
        const authUrl =
          `https://accounts.google.com/o/oauth2/v2/auth?` +
          new URLSearchParams({
            client_id: cleanId,
            redirect_uri: REDIRECT_URI,
            response_type: 'code',
            scope: SCOPES,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state: state,
            access_type: 'offline',
            prompt: 'consent'
          }).toString();

        shell.openExternal(authUrl);
      });
    });
  }

  parseEmailAddress(rawFrom) {
    const clean = rawFrom || 'Remitente desconocido';
    const match = clean.match(/^(.*?)(?:<(.+?)>)?$/);
    if (!match) return { fromName: clean, fromEmail: '' };
    const fromName = (match[1] || match[2] || clean).trim().replace(/^["']|["']$/g, '');
    const fromEmail = (match[2] || '').trim();
    return { fromName: fromName || fromEmail || 'Desconocido', fromEmail };
  }

  extractPlainTextBody(payload) {
    if (!payload) return '';
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      try {
        return Buffer.from(payload.body.data, 'base64url').toString('utf8');
      } catch {
        return '';
      }
    }
    if (Array.isArray(payload.parts)) {
      for (const part of payload.parts) {
        const found = this.extractPlainTextBody(part);
        if (found) return found;
      }
    }
    return '';
  }

  async fetchGmailJson(url, token) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 403) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(
        errData.error?.message ||
          'Gmail API no está activada en tu proyecto de Google Cloud. Actívala en console.cloud.google.com/apis/library/gmail.googleapis.com'
      );
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errMsg = `Error de Gmail (${res.status})`;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error?.message || errMsg;
      } catch {
        // ignore HTML error text
      }
      throw new Error(errMsg);
    }
    return res.json();
  }

  /**
   * Fetches unread, recent, or filtered emails from Gmail.
   */
  async fetchUnreadEmails(limit = 5, customQuery = null) {
    const token = await this.ensureValidToken();
    const safeLimit = Math.max(1, Math.min(15, Number(limit) || 5));
    const trimmedCustom = String(customQuery || '').trim();

    let listData;
    let hasUnread = false;

    if (trimmedCustom) {
      listData = await this.fetchGmailJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(trimmedCustom)}&maxResults=${safeLimit}`,
        token
      );
      hasUnread = Boolean(listData.messages?.length);
    } else {
      listData = await this.fetchGmailJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread%20in:inbox&maxResults=${safeLimit}`,
        token
      );
      hasUnread = Boolean(listData.messages && listData.messages.length > 0);

      if (!hasUnread) {
        listData = await this.fetchGmailJson(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox&maxResults=${safeLimit}`,
          token
        );
      }
    }

    const messageRefs = listData.messages || [];
    if (messageRefs.length === 0) {
      return {
        hasUnread: false,
        unreadCount: 0,
        emails: [],
        accountEmail: this.config.accountEmail
      };
    }

    const emailPromises = messageRefs.map(async (msgRef) => {
      try {
        const detailRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgRef.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!detailRes.ok) return null;
        const msg = await detailRes.json();

        const headers = msg.payload?.headers || [];
        const subjectHeader = headers.find((h) => h.name.toLowerCase() === 'subject');
        const fromHeader = headers.find((h) => h.name.toLowerCase() === 'from');
        const dateHeader = headers.find((h) => h.name.toLowerCase() === 'date');

        const rawFrom = fromHeader ? fromHeader.value : 'Remitente desconocido';
        const { fromName, fromEmail } = this.parseEmailAddress(rawFrom);
        const isMsgUnread = (msg.labelIds || []).includes('UNREAD');

        return {
          id: msg.id,
          threadId: msg.threadId,
          subject: subjectHeader ? subjectHeader.value : '(Sin asunto)',
          from: rawFrom,
          fromName,
          fromEmail,
          date: dateHeader ? dateHeader.value : '',
          snippet: msg.snippet ? msg.snippet.replace(/&#39;/g, "'").replace(/&quot;/g, '"') : '',
          isUnread: isMsgUnread,
          url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`
        };
      } catch {
        return null;
      }
    });

    const emails = (await Promise.all(emailPromises)).filter(Boolean);

    return {
      hasUnread,
      unreadCount: emails.filter((e) => e.isUnread).length,
      emails,
      accountEmail: this.config.accountEmail
    };
  }

  /**
   * Reads the full text body of the first email matching a search query (or latest inbox email).
   */
  async readEmailBody(searchQuery = '') {
    const token = await this.ensureValidToken();
    const q = String(searchQuery || '').trim() || 'in:inbox';
    const listData = await this.fetchGmailJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=1`,
      token
    );

    const firstRef = listData.messages?.[0];
    if (!firstRef) {
      return null;
    }

    const msg = await this.fetchGmailJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${firstRef.id}?format=full`,
      token
    );

    const headers = msg.payload?.headers || [];
    const subjectHeader = headers.find((h) => h.name.toLowerCase() === 'subject');
    const fromHeader = headers.find((h) => h.name.toLowerCase() === 'from');
    const dateHeader = headers.find((h) => h.name.toLowerCase() === 'date');
    const rawFrom = fromHeader ? fromHeader.value : 'Remitente desconocido';
    const { fromName, fromEmail } = this.parseEmailAddress(rawFrom);

    let bodyText = this.extractPlainTextBody(msg.payload) || msg.snippet || '';
    bodyText = bodyText
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\r?\n{3,}/g, '\n\n')
      .trim();

    if (bodyText.length > 1800) {
      bodyText = `${bodyText.slice(0, 1800)}\n...(truncado)`;
    }

    return {
      id: msg.id,
      subject: subjectHeader ? subjectHeader.value : '(Sin asunto)',
      from: rawFrom,
      fromName,
      fromEmail,
      date: dateHeader ? dateHeader.value : '',
      body: bodyText,
      url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`
    };
  }

  /**
   * Fetches upcoming Google Calendar events.
   */
  async fetchUpcomingEvents(limit = 5) {
    const token = await this.ensureValidToken();
    const nowIso = new Date().toISOString();

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(
        nowIso
      )}&maxResults=${limit}&singleEvents=true&orderBy=startTime`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (res.status === 403) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(
        errData.error?.message ||
          'Google Calendar API no está activada en tu proyecto de Google Cloud. Actívala en console.cloud.google.com/apis/library/calendar-json.googleapis.com'
      );
    }

    const data = await res.json();
    const items = data.items || [];

    return items.map((ev) => {
      const start = ev.start?.dateTime || ev.start?.date || '';
      const end = ev.end?.dateTime || ev.end?.date || '';
      return {
        id: ev.id,
        summary: ev.summary || '(Sin título)',
        description: ev.description || '',
        start,
        end,
        url: ev.htmlLink || 'https://calendar.google.com'
      };
    });
  }
}

const googleApi = new IrisGoogleApi();

module.exports = {
  googleApi,
  IrisGoogleApi
};
