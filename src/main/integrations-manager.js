/**
 * I.R.I.S. Integrations & Extensions Manager
 * ---------------------------------------------------------------------------
 * Manages external application connections (GitHub, Spotify, Notion, Discord, Google, Supabase)
 * in the same vein as Antigravity / Claude Code / MCP connectors.
 * Persists secure credentials in `config/integrations.json`.
 */

const fs = require('fs');
const path = require('path');
const spotifyApi = require('./spotify-api');
const { googleApi } = require('./google-api');
const { memoryManager } = require('./memory-manager');

const INTEGRATIONS_PATH = path.join(__dirname, '../../config/integrations.json');

class IrisIntegrationsManager {
  constructor() {
    this.integrations = this.loadIntegrations();
  }

  loadIntegrations() {
    const defaults = {
      obsidian: { vaultPath: '', connected: true },
      github: { token: '', username: '', name: '', avatar: '', connected: false },
      notion: { token: '', name: '', connected: false },
      discord: { webhookUrl: '', name: '', connected: false },
      google: { apiKey: '', connected: false },
      supabase: { projectUrl: '', anonKey: '', connected: false }
    };
    try {
      if (fs.existsSync(INTEGRATIONS_PATH)) {
        const parsed = JSON.parse(fs.readFileSync(INTEGRATIONS_PATH, 'utf8'));
        return {
          ...defaults,
          ...parsed,
          obsidian: { ...defaults.obsidian, ...(parsed.obsidian || {}) }
        };
      }
    } catch {
      // default
    }
    return defaults;
  }

  saveIntegrations() {
    try {
      fs.mkdirSync(path.dirname(INTEGRATIONS_PATH), { recursive: true });
      fs.writeFileSync(INTEGRATIONS_PATH, JSON.stringify(this.integrations, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  getIntegrationsList() {
    this.integrations = this.loadIntegrations();
    const spotifyStatus = spotifyApi.getStatus();
    const memStatus = memoryManager.getStatus();

    return [
      {
        id: 'obsidian',
        name: 'Obsidian / Memoria MD',
        icon: 'obsidian',
        description: 'Memoria cognitiva en archivos .md para ahorrar tokens (Nativa o Vault de Obsidian)',
        connected: true,
        account: memStatus.account,
        meta: {
          nativePath: memStatus.vaultPath,
          isCustomObsidian: memStatus.isCustomObsidian
        },
        fields: [
          {
            key: 'vaultPath',
            label: 'Ruta de Vault de Obsidian (opcional)',
            type: 'text',
            placeholder: 'C:\\Users\\...\\MiVault (vacío = memoria nativa)',
            value: this.integrations.obsidian?.vaultPath || '',
            hint: 'Usa memoria .md nativa por defecto. Si en el futuro usas Obsidian, pega aquí la ruta de tu Vault.'
          }
        ]
      },
      {
        id: 'github',
        name: 'GitHub',
        icon: 'github',
        description: 'Repositorios, issues, commits y perfil de desarrollador',
        connected: Boolean(this.integrations.github?.connected && this.integrations.github?.token),
        account: this.integrations.github?.username ? `@${this.integrations.github.username}` : '',
        meta: {
          name: this.integrations.github?.name || '',
          avatar: this.integrations.github?.avatar || '',
          publicRepos: this.integrations.github?.publicRepos ?? null
        },
        fields: [
          {
            key: 'token',
            label: 'Personal Access Token (PAT)',
            type: 'password',
            placeholder: 'ghp_... o github_pat_...',
            hint: 'Crea un token clásico o fine-grained en github.com/settings/tokens'
          }
        ]
      },
      {
        id: 'spotify',
        name: 'Spotify',
        icon: 'spotify',
        description: 'Control de música, búsqueda y reproducción en tiempo real',
        connected: Boolean(spotifyStatus?.connected),
        account: spotifyStatus?.userName || '',
        meta: {
          redirectUri: spotifyStatus?.redirectUri || 'http://127.0.0.1:8888/callback'
        },
        fields: [
          {
            key: 'clientId',
            label: 'Client ID',
            type: 'password',
            placeholder: 'Client ID de 32 caracteres (developer.spotify.com)',
            value: spotifyStatus?.clientId || '',
            hint: 'Añade http://127.0.0.1:8888/callback en Redirect URIs de tu app'
          }
        ]
      },
      {
        id: 'notion',
        name: 'Notion',
        icon: 'notion',
        description: 'Notas, bases de datos, tareas y documentos de tu workspace',
        connected: Boolean(this.integrations.notion?.connected && this.integrations.notion?.token),
        account: this.integrations.notion?.name || '',
        fields: [
          {
            key: 'token',
            label: 'Internal Integration Secret',
            type: 'password',
            placeholder: 'secret_...',
            hint: 'Crea una integración en notion.so/my-integrations'
          }
        ]
      },
      {
        id: 'discord',
        name: 'Discord',
        icon: 'discord',
        description: 'Envío de notificaciones, resúmenes y alertas a canales',
        connected: Boolean(this.integrations.discord?.connected && this.integrations.discord?.webhookUrl),
        account: this.integrations.discord?.name || '',
        fields: [
          {
            key: 'webhookUrl',
            label: 'Webhook URL',
            type: 'password',
            placeholder: 'https://discord.com/api/webhooks/...',
            hint: 'Copia el webhook en Ajustes de canal > Integraciones'
          }
        ]
      },
      {
        id: 'supabase',
        name: 'Supabase',
        icon: 'supabase',
        description: 'Base de datos Postgres, autenticación y storage',
        connected: Boolean(this.integrations.supabase?.connected && this.integrations.supabase?.projectUrl),
        account: this.integrations.supabase?.projectUrl ? new URL(this.integrations.supabase.projectUrl).hostname : '',
        fields: [
          {
            key: 'projectUrl',
            label: 'Project URL',
            type: 'text',
            placeholder: 'https://xyzcompany.supabase.co'
          },
          {
            key: 'anonKey',
            label: 'Anon / Service Key',
            type: 'password',
            placeholder: 'eyJhbGciOiJIUzI1Ni...'
          }
        ]
      },
      {
        id: 'google',
        name: 'Google Workspace',
        icon: 'google',
        description: 'Gmail, Google Calendar, Sheets y Drive',
        connected: Boolean(googleApi.isConnected()),
        account: googleApi.getStatus().accountEmail || '',
        meta: {
          redirectUri: googleApi.getStatus().redirectUri
        },
        fields: [
          {
            key: 'clientId',
            label: 'Client ID de Google Cloud',
            type: 'text',
            placeholder: '49328...apps.googleusercontent.com',
            value:
              googleApi.getStatus().clientId ||
              '493282729467-v7kgo0cvfa264rgelc11356ve7ts5v8m.apps.googleusercontent.com',
            hint: 'Añade http://127.0.0.1:8889/google-callback en URIs de redireccionamiento de Google Cloud'
          },
          {
            key: 'clientSecret',
            label: 'Client Secret (opcional)',
            type: 'password',
            placeholder: 'GOCSPX-... (solo si elegiste Aplicación Web)',
            value: googleApi.getStatus().clientSecret || '',
            hint: 'Para "Aplicación de escritorio", puedes dejarlo en blanco'
          }
        ]
      }
    ];
  }

  async connectService(serviceId, credentials = {}) {
    if (serviceId === 'spotify') {
      const clientId = credentials.clientId;
      return await spotifyApi.connect(clientId);
    }

    if (serviceId === 'github') {
      const token = String(credentials.token || '').trim();
      if (!token) {
        return { ok: false, error: 'Token de GitHub no proporcionado.' };
      }

      try {
        const res = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'IRIS-Desktop-Assistant',
            'Accept': 'application/vnd.github.v3+json'
          }
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          return { ok: false, error: errData.message || `Error de autenticación en GitHub (${res.status})` };
        }

        const data = await res.json();
        this.integrations.github = {
          token,
          username: data.login,
          name: data.name || data.login,
          avatar: data.avatar_url || '',
          publicRepos: data.public_repos || 0,
          connected: true
        };
        this.saveIntegrations();

        return {
          ok: true,
          status: {
            serviceId: 'github',
            connected: true,
            account: `@${data.login}`,
            name: data.name || data.login
          }
        };
      } catch (err) {
        return { ok: false, error: `Error de red: ${err.message}` };
      }
    }

    if (serviceId === 'notion') {
      const token = String(credentials.token || '').trim();
      if (!token) return { ok: false, error: 'Token de Notion no proporcionado.' };

      try {
        const res = await fetch('https://api.notion.com/v1/users/me', {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Notion-Version': '2022-06-28'
          }
        });
        if (!res.ok) {
          return { ok: false, error: 'Token de Notion inválido o expirado.' };
        }
        const data = await res.json();
        this.integrations.notion = {
          token,
          name: data.name || 'Notion Workspace',
          connected: true
        };
        this.saveIntegrations();
        return { ok: true, status: { serviceId: 'notion', connected: true, account: data.name || 'Workspace' } };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    if (serviceId === 'discord') {
      const webhookUrl = String(credentials.webhookUrl || '').trim();
      if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
        return { ok: false, error: 'URL de webhook de Discord no válida.' };
      }
      this.integrations.discord = {
        webhookUrl,
        name: 'Canal configurado',
        connected: true
      };
      this.saveIntegrations();
      return { ok: true, status: { serviceId: 'discord', connected: true, account: 'Canal conectado' } };
    }

    if (serviceId === 'supabase') {
      const projectUrl = String(credentials.projectUrl || '').trim();
      const anonKey = String(credentials.anonKey || '').trim();
      if (!projectUrl || !anonKey) {
        return { ok: false, error: 'Project URL y Anon Key requeridos.' };
      }
      this.integrations.supabase = {
        projectUrl,
        anonKey,
        connected: true
      };
      this.saveIntegrations();
      return { ok: true, status: { serviceId: 'supabase', connected: true, account: new URL(projectUrl).hostname } };
    }

    if (serviceId === 'google') {
      const clientId = credentials.clientId || credentials.apiKey;
      const clientSecret = credentials.clientSecret || '';
      const res = await googleApi.connect(clientId, clientSecret);
      if (res?.ok) {
        this.integrations.google = {
          apiKey: clientId,
          connected: true,
          account: res.status.accountEmail || 'Google Conectado'
        };
        this.saveIntegrations();
      }
      return res;
    }

    if (serviceId === 'obsidian') {
      const rawPath = String(credentials.vaultPath || '').trim();
      if (!rawPath) {
        this.integrations.obsidian = { vaultPath: '', connected: true };
        this.saveIntegrations();
        memoryManager.ensureInitialized();
        return { ok: true, status: memoryManager.getStatus() };
      }

      const resolved = path.resolve(rawPath);
      try {
        if (!fs.existsSync(resolved)) {
          fs.mkdirSync(resolved, { recursive: true });
        } else if (!fs.statSync(resolved).isDirectory()) {
          return { ok: false, error: 'La ruta indicada no es una carpeta válida.' };
        }
        this.integrations.obsidian = { vaultPath: resolved, connected: true };
        this.saveIntegrations();
        memoryManager.ensureInitialized();
        return { ok: true, status: memoryManager.getStatus() };
      } catch (err) {
        return { ok: false, error: `No se pudo acceder a la carpeta: ${err.message}` };
      }
    }

    return { ok: false, error: 'Servicio no reconocido.' };
  }

  disconnectService(serviceId) {
    if (serviceId === 'obsidian') {
      this.integrations.obsidian = { vaultPath: '', connected: true };
      this.saveIntegrations();
      memoryManager.ensureInitialized();
      return { ok: true, connected: true };
    }

    if (serviceId === 'spotify') {
      spotifyApi.disconnect();
      return { ok: true, connected: false };
    }

    if (serviceId === 'google') {
      googleApi.disconnect();
      this.integrations.google = { apiKey: '', connected: false, account: '' };
      this.saveIntegrations();
      return { ok: true, connected: false };
    }

    if (this.integrations[serviceId]) {
      this.integrations[serviceId].connected = false;
      this.integrations[serviceId].token = '';
      if (this.integrations[serviceId].webhookUrl) this.integrations[serviceId].webhookUrl = '';
      if (this.integrations[serviceId].apiKey) this.integrations[serviceId].apiKey = '';
      if (this.integrations[serviceId].anonKey) this.integrations[serviceId].anonKey = '';
      this.saveIntegrations();
    }
    return { ok: true, connected: false };
  }

  isGitHubConnected() {
    this.integrations = this.loadIntegrations();
    return Boolean(this.integrations.github?.connected && this.integrations.github?.token);
  }

  isDiscordConnected() {
    this.integrations = this.loadIntegrations();
    return Boolean(this.integrations.discord?.connected && this.integrations.discord?.webhookUrl);
  }

  isNotionConnected() {
    this.integrations = this.loadIntegrations();
    return Boolean(this.integrations.notion?.connected && this.integrations.notion?.token);
  }

  getActiveIntegrationsSummary() {
    this.integrations = this.loadIntegrations();
    const active = [];
    if (spotifyApi.isConnected()) active.push('Spotify (conectado)');
    if (googleApi.isConnected()) active.push(`Google Workspace (${googleApi.getStatus().accountEmail || 'conectado'})`);
    if (this.isGitHubConnected()) active.push(`GitHub (@${this.integrations.github.username || 'conectado'})`);
    if (this.isNotionConnected()) active.push('Notion (conectado)');
    if (this.isDiscordConnected()) active.push('Discord Webhook (conectado)');
    active.push(`Memoria Markdown (${memoryManager.getStatus().account})`);
    return active.join(', ');
  }

  async fetchGitHubRepos(limit = 5) {
    if (!this.isGitHubConnected()) return null;
    const token = this.integrations.github.token;
    try {
      const res = await fetch(`https://api.github.com/user/repos?sort=updated&per_page=${limit}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'IRIS-Desktop-Assistant',
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.map((r) => ({
        name: r.name,
        fullName: r.full_name,
        description: r.description || 'Sin descripción',
        url: r.html_url,
        private: r.private,
        language: r.language || '',
        updatedAt: r.updated_at
      }));
    } catch {
      return null;
    }
  }

  async sendDiscordWebhook(message) {
    if (!this.isDiscordConnected()) {
      return { ok: false, error: 'Discord no está conectado en Ajustes > Conexiones.' };
    }
    const content = String(message || '').trim();
    if (!content) return { ok: false, error: 'Mensaje vacío.' };
    try {
      const res = await fetch(this.integrations.discord.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      if (!res.ok) {
        return { ok: false, error: `Discord respondió con HTTP ${res.status}` };
      }
      return { ok: true, sent: content };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async searchNotionPages(query = '') {
    if (!this.isNotionConnected()) {
      return { ok: false, error: 'Notion no está conectado en Ajustes > Conexiones.' };
    }
    try {
      const res = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.integrations.notion.token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: String(query || ''), page_size: 5 })
      });
      if (!res.ok) {
        return { ok: false, error: `Error de Notion (${res.status})` };
      }
      const data = await res.json();
      const pages = (data.results || []).map((p) => {
        let title = 'Página de Notion';
        if (p.properties) {
          const titleProp = Object.values(p.properties).find((prop) => prop?.type === 'title');
          const txt = titleProp?.title?.map((t) => t.plain_text).join('').trim();
          if (txt) title = txt;
        }
        return {
          id: p.id,
          title,
          url: p.url || 'https://www.notion.so'
        };
      });
      return { ok: true, pages };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

const integrationsManager = new IrisIntegrationsManager();

module.exports = {
  integrationsManager,
  IrisIntegrationsManager
};
