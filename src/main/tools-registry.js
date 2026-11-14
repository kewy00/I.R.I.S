/**
 * I.R.I.S. Unified Agentic Tools Registry (Native Function Calling)
 * ---------------------------------------------------------------------------
 * Replaces hardcoded keyword routing with structured tool declarations usable
 * by both Google Gemini (`functionDeclarations`) and local Ollama (`tools`).
 */

const spotifyApi = require('./spotify-api');
const { googleApi } = require('./google-api');
const { memoryManager } = require('./memory-manager');
const { integrationsManager } = require('./integrations-manager');
const { playMusicOrVideo, executeMediaControl } = require('./agent-executor');
const { openWindowsApp, getSystemStatsSummary } = require('./os-tools');

const TOOL_DEFINITIONS = [
  {
    name: 'spotify_play',
    description:
      'Busca y reproduce una canción, álbum, artista o playlist en Spotify o YouTube. Úsala cuando el usuario pida escuchar o poner música.',
    directFinal: true,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Nombre limpio de la canción, artista, álbum o playlist (ej. "Daft Punk Instant Crush", "Graduation Kanye West").'
        },
        entityType: {
          type: 'string',
          enum: ['track', 'album', 'artist', 'playlist'],
          description: 'Tipo de contenido a reproducir en Spotify.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'spotify_control',
    description:
      'Controla la reproducción de Spotify o del audio del sistema: pausar, reanudar, alternar play/pausa, siguiente canción, anterior, silenciar o cambiar volumen.',
    directFinal: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'play_pause', 'next', 'previous', 'vol_up', 'vol_down', 'set_volume', 'mute'],
          description: 'Acción de control multimedia a ejecutar.'
        },
        volumePercent: {
          type: 'integer',
          description: 'Porcentaje de volumen (0 a 100) si action es "set_volume".'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'spotify_now_playing',
    description: 'Consulta qué canción, artista y dispositivo están sonando ahora mismo en Spotify.',
    directFinal: false,
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'gmail_search_emails',
    description:
      'Busca o lista correos electrónicos en Gmail del usuario. Soporta sintaxis de Gmail en searchQuery (ej. "from:OpenAI", "is:unread", "github newer_than:7d") o vacío para ver los últimos no leídos/recientes.',
    directFinal: false,
    parameters: {
      type: 'object',
      properties: {
        searchQuery: {
          type: 'string',
          description: 'Consulta estilo Gmail para filtrar correos (ej. "from:OpenAI", "is:unread", "factura"). Déjalo vacío para bandeja de entrada reciente/no leídos.'
        },
        maxResults: {
          type: 'integer',
          description: 'Número máximo de correos a devolver (por defecto 5).'
        }
      }
    }
  },
  {
    name: 'gmail_read_email',
    description:
      'Lee el contenido completo de un correo específico en Gmail para resumirlo o responder preguntas sobre él.',
    directFinal: false,
    parameters: {
      type: 'object',
      properties: {
        searchQuery: {
          type: 'string',
          description: 'Términos para localizar el correo (remitente o asunto, ej. "from:github" o "OpenAI").'
        }
      },
      required: ['searchQuery']
    }
  },
  {
    name: 'calendar_get_events',
    description: 'Consulta los próximos eventos, reuniones o citas en Google Calendar.',
    directFinal: false,
    parameters: {
      type: 'object',
      properties: {
        maxResults: {
          type: 'integer',
          description: 'Cantidad máxima de eventos próximos a consultar (por defecto 5).'
        }
      }
    }
  },
  {
    name: 'github_list_repos',
    description: 'Lista o filtra los repositorios de GitHub conectados del usuario.',
    directFinal: false,
    parameters: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Texto opcional para filtrar repositorios por nombre o lenguaje.'
        },
        limit: {
          type: 'integer',
          description: 'Máximo de repositorios a consultar (por defecto 6).'
        }
      }
    }
  },
  {
    name: 'memory_remember',
    description:
      'Guarda un dato permanente sobre el usuario (gustos, nombre, preferencias, contexto de proyecto) en MEMORY.md para recordarlo en futuras sesiones.',
    directFinal: false,
    parameters: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description: 'Frase concisa del hecho o preferencia a recordar.'
        },
        category: {
          type: 'string',
          enum: ['Perfil del Usuario', 'Preferencias y Gustos', 'Proyectos y Contexto', 'Notas Guardadas'],
          description: 'Categoría en MEMORY.md.'
        }
      },
      required: ['fact']
    }
  },
  {
    name: 'memory_notes',
    description:
      'Gestiona notas largas en archivos Markdown (.md) en la memoria nativa o Vault de Obsidian: buscar notas, crear/escribir nota nueva, leer una nota completa o listar todas.',
    directFinal: false,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'write', 'read', 'list'],
          description: 'Operación sobre los archivos .md de memoria.'
        },
        query: {
          type: 'string',
          description: 'Términos de búsqueda cuando action es "search", o nombre de nota cuando action es "read".'
        },
        title: {
          type: 'string',
          description: 'Título de la nota cuando action es "write" o "read".'
        },
        content: {
          type: 'string',
          description: 'Contenido Markdown a escribir cuando action es "write".'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'discord_send_message',
    description: 'Envía un mensaje, resumen o notificación al canal de Discord conectado mediante Webhook.',
    directFinal: false,
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Texto del mensaje a publicar en Discord.'
        }
      },
      required: ['message']
    }
  },
  {
    name: 'notion_search',
    description: 'Busca páginas o bases de datos en el workspace de Notion conectado.',
    directFinal: false,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Palabra clave para buscar en Notion.'
        }
      }
    }
  },
  {
    name: 'os_open_app',
    description: 'Abre cualquier aplicación instalada en Windows o sitio web conocido (ej. Visual Studio Code, Discord, Calculadora, Chrome, Spotify).',
    directFinal: true,
    parameters: {
      type: 'object',
      properties: {
        appName: {
          type: 'string',
          description: 'Nombre de la aplicación o programa a abrir.'
        }
      },
      required: ['appName']
    }
  },
  {
    name: 'os_system_stats',
    description: 'Obtiene el uso actual de memoria RAM y estadísticas básicas del PC.',
    directFinal: true,
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'os_inspect_screen',
    description:
      'Captura la pantalla actual del usuario y la analiza visualmente con IA de visión. Úsala siempre que el usuario pregunte qué hay en pantalla, pida ayuda con lo que está viendo o señale "esto" / "este error".',
    directFinal: true,
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Pregunta específica del usuario sobre su pantalla.'
        }
      },
      required: ['question']
    }
  }
];

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  const out = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (Array.isArray(schema.required) && schema.required.length > 0) out.required = schema.required;
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = toGeminiSchema(v);
    }
  }
  return out;
}

class IrisToolsRegistry {
  getToolMeta(name) {
    return TOOL_DEFINITIONS.find((t) => t.name === name) || null;
  }

  getGeminiDeclarations() {
    return TOOL_DEFINITIONS.map((t) => {
      const decl = {
        name: t.name,
        description: t.description
      };
      if (t.parameters && Object.keys(t.parameters.properties || {}).length > 0) {
        decl.parameters = toGeminiSchema(t.parameters);
      }
      return decl;
    });
  }

  getOllamaTools() {
    return TOOL_DEFINITIONS.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }

  async executeTool(name, args = {}, orchestrator = null) {
    try {
      switch (name) {
        case 'spotify_play': {
          const query = String(args.query || '').trim();
          const entityType = args.entityType || null;
          const res = await playMusicOrVideo(query, null, entityType);
          return {
            data: { ok: Boolean(res.executed), query, entityType, reply: res.reply },
            artifact: res.artifact || null,
            fallbackReply: res.reply,
            expression: 'Feliz'
          };
        }

        case 'spotify_control': {
          const action = args.action || 'play_pause';
          const vol = args.volumePercent !== undefined ? Number(args.volumePercent) : null;
          const msg = await executeMediaControl(action, vol);
          return {
            data: { ok: true, action, message: msg },
            artifact: null,
            fallbackReply: msg,
            expression: 'Feliz'
          };
        }

        case 'spotify_now_playing': {
          const res = await spotifyApi.getNowPlaying();
          if (!res.ok) {
            const msg =
              res.error === 'SPOTIFY_NOT_CONNECTED'
                ? 'Spotify no está conectado en Ajustes.'
                : 'No hay ninguna canción sonando ahora mismo en Spotify.';
            return { data: res, artifact: null, fallbackReply: msg, expression: 'Disponible' };
          }
          const title = res.artistName ? `${res.trackName} — ${res.artistName}` : res.trackName;
          const msg = res.isPlaying
            ? `Ahora mismo está sonando "${title}" en ${res.deviceName}.`
            : `Tienes en pausa "${title}" en ${res.deviceName}.`;
          return {
            data: res,
            artifact: null,
            fallbackReply: msg,
            expression: 'Feliz'
          };
        }

        case 'gmail_search_emails': {
          if (!googleApi.isConnected()) {
            return {
              data: { ok: false, error: 'Google Workspace no conectado' },
              artifact: {
                badge: 'Google Workspace',
                title: 'Autorización de Gmail requerida',
                subtitle: 'Conecta Google Workspace en Ajustes > Conexiones',
                actions: [{ label: 'Abrir Gmail web', url: 'https://mail.google.com' }]
              },
              fallbackReply:
                'Google Workspace no está autorizado todavía. Conéctalo desde Ajustes > Conexiones para que pueda consultar tus correos.',
              expression: 'Duda'
            };
          }

          const limit = Number(args.maxResults) || 5;
          const searchQuery = args.searchQuery || null;
          const result = await googleApi.fetchUnreadEmails(limit, searchQuery);
          const { emails, accountEmail, hasUnread, unreadCount } = result;

          if (!emails || emails.length === 0) {
            const emptyMsg = searchQuery
              ? `No encontré correos que coincidan con "${searchQuery}".`
              : `No tienes correos nuevos en tu bandeja de entrada${accountEmail ? ` (${accountEmail})` : ''}.`;
            return {
              data: { ok: true, count: 0, emails: [], accountEmail },
              artifact: null,
              fallbackReply: emptyMsg,
              expression: 'Feliz'
            };
          }

          const summary = searchQuery
            ? `Encontré ${emails.length} correo${emails.length === 1 ? '' : 's'} para "${searchQuery}": el más reciente es de ${emails[0].fromName} sobre "${emails[0].subject}".`
            : hasUnread
              ? `Tienes ${unreadCount} correo${unreadCount === 1 ? '' : 's'} nuevo${unreadCount === 1 ? '' : 's'}: el más reciente de ${emails[0].fromName} sobre "${emails[0].subject}".`
              : `No tienes correos sin leer. Tu último correo recibido es de ${emails[0].fromName} sobre "${emails[0].subject}".`;

          return {
            data: {
              ok: true,
              accountEmail,
              hasUnread,
              unreadCount,
              emails: emails.map((e) => ({
                fromName: e.fromName,
                subject: e.subject,
                date: e.date,
                snippet: e.snippet,
                isUnread: e.isUnread
              }))
            },
            artifact: {
              badge: 'Gmail',
              title: searchQuery
                ? `Resultados Gmail: ${searchQuery}`
                : hasUnread
                  ? `Bandeja de entrada (${unreadCount} nuevo${unreadCount === 1 ? '' : 's'})`
                  : 'Correos recientes en Gmail',
              subtitle: accountEmail || 'Google Workspace',
              items: emails.map((e) => ({
                label: `${e.fromName}: ${e.subject}`,
                actionLabel: 'Abrir',
                url: e.url
              })),
              actions: [{ label: 'Abrir Gmail', url: 'https://mail.google.com' }]
            },
            fallbackReply: summary,
            expression: 'Feliz'
          };
        }

        case 'gmail_read_email': {
          if (!googleApi.isConnected()) {
            return {
              data: { ok: false, error: 'Google Workspace no conectado' },
              artifact: null,
              fallbackReply: 'Google Workspace no está conectado en Ajustes.',
              expression: 'Duda'
            };
          }
          const email = await googleApi.readEmailBody(args.searchQuery || '');
          if (!email) {
            return {
              data: { ok: false, error: 'No se encontró ningún correo.' },
              artifact: null,
              fallbackReply: `No encontré ningún correo relacionado con "${args.searchQuery}".`,
              expression: 'Duda'
            };
          }
          return {
            data: {
              ok: true,
              fromName: email.fromName,
              subject: email.subject,
              date: email.date,
              body: email.body
            },
            artifact: {
              badge: 'Correo leído',
              title: email.subject,
              subtitle: `De: ${email.fromName}`,
              actions: [{ label: 'Abrir en Gmail', url: email.url }]
            },
            fallbackReply: `Correo de ${email.fromName} con asunto "${email.subject}": ${email.body.slice(0, 180)}`,
            expression: 'Feliz'
          };
        }

        case 'calendar_get_events': {
          if (!googleApi.isConnected()) {
            return {
              data: { ok: false, error: 'Google Calendar no conectado' },
              artifact: {
                badge: 'Google Workspace',
                title: 'Conectar Google Calendar',
                subtitle: 'Autorización requerida',
                actions: [{ label: 'Abrir Google Calendar', url: 'https://calendar.google.com' }]
              },
              fallbackReply: 'Google Calendar no está conectado. Conéctalo desde Ajustes > Conexiones.',
              expression: 'Duda'
            };
          }
          const events = await googleApi.fetchUpcomingEvents(Number(args.maxResults) || 5);
          if (!events || events.length === 0) {
            return {
              data: { ok: true, events: [] },
              artifact: null,
              fallbackReply: 'No tienes eventos ni reuniones próximas en tu Google Calendar.',
              expression: 'Feliz'
            };
          }
          return {
            data: { ok: true, events },
            artifact: {
              badge: 'Google Calendar',
              title: 'Próximos eventos',
              subtitle: `${events.length} citas programadas`,
              items: events.map((ev) => ({
                label: `${ev.summary} (${ev.start ? ev.start.replace('T', ' ').slice(0, 16) : 'Todo el día'})`,
                actionLabel: 'Ver evento',
                url: ev.url
              })),
              actions: [{ label: 'Abrir Google Calendar', url: 'https://calendar.google.com' }]
            },
            fallbackReply: `Tienes ${events.length} evento${events.length === 1 ? '' : 's'} próximo${events.length === 1 ? '' : 's'}. El siguiente es "${events[0].summary}".`,
            expression: 'Feliz'
          };
        }

        case 'github_list_repos': {
          if (!integrationsManager.isGitHubConnected()) {
            return {
              data: { ok: false, error: 'GitHub no conectado' },
              artifact: {
                badge: 'Integración',
                title: 'Conectar GitHub a Iris',
                subtitle: 'Personal Access Token requerido',
                actions: [{ label: 'Crear token en GitHub', url: 'https://github.com/settings/tokens' }]
              },
              fallbackReply: 'GitHub aún no está conectado. Añade tu Personal Access Token en Ajustes > Conexiones.',
              expression: 'Duda'
            };
          }
          let repos = (await integrationsManager.fetchGitHubRepos(Number(args.limit) || 10)) || [];
          if (args.search) {
            const term = String(args.search).toLowerCase();
            repos = repos.filter(
              (r) =>
                r.name.toLowerCase().includes(term) ||
                r.description.toLowerCase().includes(term) ||
                r.language.toLowerCase().includes(term)
            );
          }
          const username = integrationsManager.integrations?.github?.username || 'repos';
          return {
            data: { ok: true, username, repos },
            artifact: {
              badge: 'GitHub',
              title: `GitHub · @${username}`,
              subtitle: `${repos.length} proyecto${repos.length === 1 ? '' : 's'} encontrado${repos.length === 1 ? '' : 's'}`,
              items: repos.slice(0, 6).map((r) => ({
                label: `${r.name}${r.language ? ` [${r.language}]` : ''}`,
                actionLabel: 'Abrir',
                url: r.url
              })),
              actions: [{ label: 'Ver perfil en GitHub', url: `https://github.com/${username}` }]
            },
            fallbackReply:
              repos.length > 0
                ? `Tienes ${repos.length} repositorios en GitHub, el más reciente es ${repos[0].name}.`
                : 'No encontré repositorios con ese filtro en tu cuenta de GitHub.',
            expression: 'Feliz'
          };
        }

        case 'memory_remember': {
          const res = memoryManager.rememberFact(args.fact, args.category);
          return {
            data: res,
            artifact: null,
            fallbackReply: res.ok
              ? `Anotado en mi memoria: ${res.fact}.`
              : 'No pude guardar ese dato en la memoria.',
            expression: 'Feliz'
          };
        }

        case 'memory_notes': {
          const action = args.action || 'search';
          if (action === 'write') {
            const res = memoryManager.writeNote({ title: args.title || 'Nota', content: args.content || '' });
            return {
              data: res,
              artifact: {
                badge: 'Nota .md',
                title: res.title,
                subtitle: `Guardado en ${res.fileName}`,
                actions: [{ label: 'Abrir archivo .md', url: res.filePath }]
              },
              fallbackReply: `He guardado la nota "${res.title}" en tu memoria Markdown.`,
              expression: 'Feliz'
            };
          }
          if (action === 'read') {
            const res = memoryManager.readNote(args.title || args.query || '');
            return {
              data: res,
              artifact: res.ok
                ? {
                    badge: 'Nota .md',
                    title: res.title,
                    subtitle: res.fileName,
                    actions: [{ label: 'Abrir archivo .md', url: res.filePath }]
                  }
                : null,
              fallbackReply: res.ok ? `Contenido de ${res.title}: ${res.content.slice(0, 200)}` : res.error,
              expression: res.ok ? 'Feliz' : 'Duda'
            };
          }
          if (action === 'list') {
            const notes = memoryManager.listNotes();
            return {
              data: { ok: true, count: notes.length, notes },
              artifact: {
                badge: 'Memoria .md',
                title: `${notes.length} archivo${notes.length === 1 ? '' : 's'} en memoria`,
                subtitle: memoryManager.getStatus().account,
                items: notes.slice(0, 6).map((n) => ({
                  label: n.title,
                  actionLabel: 'Abrir',
                  url: n.filePath
                })),
                actions: [{ label: 'Abrir carpeta', url: memoryManager.getVaultDir() }]
              },
              fallbackReply: `Tienes ${notes.length} archivos Markdown en tu memoria.`,
              expression: 'Feliz'
            };
          }
          const searchRes = memoryManager.searchNotes(args.query || '');
          const matches = searchRes.matches || [];
          return {
            data: searchRes,
            artifact:
              matches.length > 0
                ? {
                    badge: 'Memoria .md',
                    title: `Resultados: ${args.query || 'notas'}`,
                    subtitle: `${matches.length} coincidencia${matches.length === 1 ? '' : 's'}`,
                    items: matches.map((m) => ({
                      label: `${m.title}: ${m.excerpt.slice(0, 60)}`,
                      actionLabel: 'Abrir',
                      url: m.filePath
                    }))
                  }
                : null,
            fallbackReply:
              matches.length > 0
                ? `Encontré "${matches[0].title}": ${matches[0].excerpt}`
                : 'No encontré notas guardadas sobre ese tema.',
            expression: 'Feliz'
          };
        }

        case 'discord_send_message': {
          const res = await integrationsManager.sendDiscordWebhook(args.message);
          return {
            data: res,
            artifact: null,
            fallbackReply: res.ok ? 'He enviado el mensaje a tu canal de Discord.' : res.error,
            expression: res.ok ? 'Feliz' : 'Duda'
          };
        }

        case 'notion_search': {
          const res = await integrationsManager.searchNotionPages(args.query || '');
          if (!res.ok) {
            return { data: res, artifact: null, fallbackReply: res.error, expression: 'Duda' };
          }
          const pages = res.pages || [];
          return {
            data: res,
            artifact: {
              badge: 'Notion',
              title: `Notion: "${args.query || 'recientes'}"`,
              subtitle: `${pages.length} página${pages.length === 1 ? '' : 's'}`,
              items: pages.map((p) => ({ label: p.title, actionLabel: 'Abrir', url: p.url }))
            },
            fallbackReply:
              pages.length > 0
                ? `Encontré ${pages.length} página${pages.length === 1 ? '' : 's'} en Notion, como "${pages[0].title}".`
                : 'No encontré páginas en Notion con esa búsqueda.',
            expression: 'Feliz'
          };
        }

        case 'os_open_app': {
          const reply = await openWindowsApp(args.appName || '');
          return {
            data: { ok: true, appName: args.appName, reply },
            artifact: null,
            fallbackReply: reply,
            expression: 'Feliz'
          };
        }

        case 'os_system_stats': {
          const stats = getSystemStatsSummary();
          return {
            data: { ok: true, stats },
            artifact: null,
            fallbackReply: stats,
            expression: 'Respondiendo'
          };
        }

        case 'os_inspect_screen': {
          if (orchestrator && typeof orchestrator.executeVisionTask === 'function') {
            const visionRes = await orchestrator.executeVisionTask(args.question || '¿Qué hay en mi pantalla?');
            return {
              data: { ok: true, analysis: visionRes.reply },
              artifact: visionRes.artifact || null,
              fallbackReply: visionRes.reply,
              expression: visionRes.expression || 'Feliz'
            };
          }
          return {
            data: { ok: false, error: 'Visión no disponible' },
            artifact: null,
            fallbackReply: 'No pude activar el módulo de visión en este momento.',
            expression: 'Disponible'
          };
        }

        default:
          return {
            data: { ok: false, error: `Herramienta desconocida: ${name}` },
            artifact: null,
            fallbackReply: 'No reconocí esa acción.',
            expression: 'Duda'
          };
      }
    } catch (err) {
      return {
        data: { ok: false, error: err.message },
        artifact: null,
        fallbackReply: `Ocurrió un error al ejecutar ${name}: ${err.message}`,
        expression: 'Triste'
      };
    }
  }
}

const toolsRegistry = new IrisToolsRegistry();

module.exports = {
  toolsRegistry,
  IrisToolsRegistry,
  TOOL_DEFINITIONS
};
