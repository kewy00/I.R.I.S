/**
 * I.R.I.S. Hybrid AI Orchestrator + Autonomous Agent & Artifacts Engine
 * ---------------------------------------------------------------------------
 * 1. Native LLM Function Calling / Tool Calling:
 *    - Delegates intent understanding to Gemini (`functionDeclarations`) or
 *      local Ollama (`/api/chat` with `tools`) instead of brittle keyword rules.
 *    - Combines active `.md` core memory (`MEMORY.md`) with on-demand Markdown /
 *      Obsidian note tools (`memory_remember`, `memory_notes`).
 * 2. Interactive Artifacts System:
 *    - Generates rich interactive cards below the bar (Media controller,
 *      Clickable emails/calendar/repos/notes, Copyable code blocks, Vision preview).
 */

const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { desktopCapturer, shell } = require('electron');
const { openWindowsApp, getSystemStatsSummary, resolveWindowAppAliases } = require('./os-tools');
const { playMusicOrVideo, executeMediaControl } = require('./agent-executor');
const spotifyApi = require('./spotify-api');
const { integrationsManager } = require('./integrations-manager');
const { googleApi } = require('./google-api');
const { memoryManager } = require('./memory-manager');
const { toolsRegistry } = require('./tools-registry');

const CONFIG_PATH = path.join(__dirname, '../../config/ai-config.json');
const HISTORY_PATH = path.join(__dirname, '../../config/chat-history.json');

class IrisAIOrchestrator {
  constructor(onBackgroundReply) {
    this.onBackgroundReply = onBackgroundReply || (() => {});
    this.config = this.loadConfig();
    this.quotaCooldowns = new Map();
    this.conversationHistory = [];
    this.ollamaReady = false;
    try {
      memoryManager.ensureInitialized();
    } catch {
      // ignore memory bootstrap error
    }
  }

  loadConfig() {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (process.env.GEMINI_API_KEY && !parsed.gemini.apiKeys.includes(process.env.GEMINI_API_KEY)) {
        parsed.gemini.apiKeys.unshift(process.env.GEMINI_API_KEY);
      }
      return parsed;
    } catch {
      return {
        ui: { accentColor: '#ff4776' },
        ollama: {
          baseUrl: 'http://127.0.0.1:11434',
          executablePath: 'C:\\Users\\slkew\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
          primaryModel: 'llama3.2:3b',
          fallbackModels: ['llama3.2:latest', 'llama3.2:1b'],
          keepAlive: -1
        },
        gemini: {
          apiKeys: process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY] : [],
          thinkingTextModels: [
            'gemini-flash-lite-latest',
            'gemini-3.1-flash-lite',
            'gemini-3.5-flash-lite',
            'gemini-3-flash-preview',
            'gemini-2.5-flash'
          ],
          visionImageModels: [
            'gemini-flash-lite-latest',
            'gemini-3.1-flash-lite',
            'gemini-3.5-flash-lite',
            'gemini-2.5-flash'
          ],
          cooldownMsOnQuotaExhausted: 60000
        }
      };
    }
  }

  loadChatHistory() {
    try {
      if (fs.existsSync(HISTORY_PATH)) {
        const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return [
      { id: 1, sender: 'user', text: 'Hola, ¿cómo vas?', streaming: false, typing: false },
      { id: 2, sender: 'ai', text: 'Hola, estoy bien', streaming: false, typing: false }
    ];
  }

  saveChatHistory(messages) {
    try {
      const clean = (messages || [])
        .filter((m) => !m.typing)
        .slice(-100)
        .map((m) => ({
          id: m.id,
          sender: m.sender,
          text: m.text,
          streaming: false,
          typing: false
        }));
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(clean, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  saveApiKey(newKey) {
    const cleanKey = newKey.trim();
    if (!cleanKey) return false;
    this.config = this.loadConfig();
    if (!this.config.gemini.apiKeys.includes(cleanKey)) {
      this.config.gemini.apiKeys.push(cleanKey);
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf8');
    }
    return this.config.gemini.apiKeys.length;
  }

  getSettings() {
    this.config = this.loadConfig();
    return {
      accentColor: this.config?.ui?.accentColor || '#ff4776',
      doNotDisturb: Boolean(this.config?.ui?.doNotDisturb),
      autoStart: this.config?.ui?.autoStart !== false,
      primaryModel: this.config?.ollama?.primaryModel || 'llama3.2:3b',
      apiKeys: this.config?.gemini?.apiKeys || []
    };
  }

  updateSettings(updates = {}) {
    this.config = this.loadConfig();
    if (!this.config.ui) this.config.ui = { accentColor: '#ff4776' };

    if (updates.accentColor) {
      this.config.ui.accentColor = updates.accentColor;
    }
    if (typeof updates.doNotDisturb === 'boolean') {
      this.config.ui.doNotDisturb = updates.doNotDisturb;
    }
    if (typeof updates.autoStart === 'boolean') {
      this.config.ui.autoStart = updates.autoStart;
    }
    if (updates.primaryModel) {
      this.config.ollama.primaryModel = updates.primaryModel;
      this.prewarmLocalModel();
    }
    if (Array.isArray(updates.apiKeys)) {
      this.config.gemini.apiKeys = updates.apiKeys.map((k) => k.trim()).filter(Boolean);
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf8');
    return this.getSettings();
  }

  async listOllamaModels() {
    const baseUrl = this.config.ollama.baseUrl;
    try {
      const res = await fetch(`${baseUrl}/api/tags`);
      if (res.ok) {
        const data = await res.json();
        const names = (data.models || []).map((m) => m.name);
        if (names.length > 0) return names;
      }
    } catch {
      // fallback
    }
    return [
      'llama3.2:3b',
      'llama3.2:1b',
      'llama3.2:latest',
      'qwen2.5:3b',
      'qwen2.5:1.5b',
      'phi4-mini:latest',
      'gemma3:4b',
      'tinyllama:latest'
    ];
  }

  async ensureOllamaRunning() {
    const baseUrl = this.config.ollama.baseUrl;
    try {
      const res = await fetch(`${baseUrl}/api/tags`);
      if (res.ok) {
        this.ollamaReady = true;
        this.prewarmLocalModel();
        return true;
      }
    } catch {
      // Spawn `ollama serve`
    }

    try {
      const exe = this.config.ollama.executablePath || 'ollama';
      const child = spawn(exe, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();

      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const check = await fetch(`${baseUrl}/api/tags`);
          if (check.ok) {
            this.ollamaReady = true;
            this.prewarmLocalModel();
            return true;
          }
        } catch {
          // keep waiting
        }
      }
    } catch (err) {
      console.warn('[IRIS Ollama] Could not spawn ollama serve:', err.message);
    }
    return false;
  }

  async prewarmLocalModel() {
    const baseUrl = this.config.ollama.baseUrl;
    const model = this.config.ollama.primaryModel || 'llama3.2:3b';
    try {
      await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: 'Hola',
          stream: false,
          keep_alive: -1,
          options: { num_predict: 1 }
        })
      });
    } catch {
      // ignore
    }
  }

  detectApiKeyOnly(userPrompt) {
    const trimmed = String(userPrompt || '').trim();
    const explicitKeyMatch =
      trimmed.match(/((?:AIza|AQ\.|ya29\.|gsk_|sk-)[0-9A-Za-z\-_.]{20,})/) ||
      (/^[A-Za-z0-9\-_.]{28,}$/.test(trimmed) ? [trimmed, trimmed] : null);
    return explicitKeyMatch ? explicitKeyMatch[1] : null;
  }

  pushConversationTurn(userPrompt, reply) {
    const cleanUser = String(userPrompt || '').trim();
    const cleanReply = String(reply || '').trim();
    if (!cleanUser || !cleanReply) return;
    this.conversationHistory.push({ role: 'user', content: cleanUser });
    this.conversationHistory.push({ role: 'assistant', content: cleanReply });
    if (this.conversationHistory.length > 12) {
      this.conversationHistory = this.conversationHistory.slice(-12);
    }
  }

  buildAgentSystemInstruction() {
    const nowStr = new Date().toLocaleString('es-ES', {
      dateStyle: 'full',
      timeStyle: 'short'
    });
    const integrationsSummary =
      typeof integrationsManager.getActiveIntegrationsSummary === 'function'
        ? integrationsManager.getActiveIntegrationsSummary()
        : '';
    const memoryContext =
      typeof memoryManager.getCoreMemoryContext === 'function'
        ? memoryManager.getCoreMemoryContext()
        : '';

    return [
      'Eres Iris, el asistente de escritorio inteligente del usuario en Windows.',
      `Fecha y hora actual: ${nowStr}.`,
      '',
      'REGLAS DE RESPUESTA Y HONESTIDAD:',
      '- Responde SIEMPRE en español natural, directo y conciso (1 a 3 frases aptas para síntesis de voz, sin emojis ni markdown pesado).',
      '- NUNCA finjas ni inventes haber ejecutado una acción externa (poner música, pausar, enviar mensajes, leer correos, guardar notas, abrir programas o ver la pantalla) si no llamaste antes a una herramienta real y recibiste su resultado.',
      '- Interpreta la intención real del usuario de forma natural y llama directamente a la herramienta adecuada.',
      '- Si una herramienta devuelve `connected: false`, explícale honestamente cómo conectarla en Ajustes > Conexiones.',
      '- Memoria Markdown: si el usuario aporta un dato personal duradero (preferencias, proyectos, gustos, equipo, rutinas) o pide recordar algo, usa `memory_remember` o `memory_notes`. Si pregunta por datos antiguos que no aparecen en la memoria núcleo de abajo, busca con `memory_notes` (`search` / `read`) antes de decir que no lo sabes.',
      '- Vídeos, Clips y Web: si el usuario pide buscar, ver o poner un clip, vídeo, momento de streamer, directo o búsqueda en Internet, usa SIEMPRE `youtube_search_play` o `web_search`. Corrige posibles errores fonéticos del micrófono en nombres de creadores (ej. "Wanger" -> "Guanyar", "Dj Mario" -> "DjMaRiiO"). Nunca digas que no tienes herramientas para buscar clips o vídeos.',
      '- Control de Ventanas y Pantallas: cuando el usuario pida cerrar una app/ventana, minimizar, maximizar, restaurar, poner a un lado o mover una aplicación a otra pantalla/monitor (ej. "mueve Antigravity a la segunda pantalla", "mueve Spotify a mi pantalla principal", "cierra Spotify", "minimiza Spotify"), usa SIEMPRE `os_window_control` (parámetros `action`, `appName`, `monitor`). NUNCA uses `web_search` ni `os_open_app` para cerrar o minimizar programas. Si una rutina como "modo trabajo" implica música, abrir apps y mover ventanas a pantallas concretas según la memoria, llama en el mismo turno a `spotify_play`, `os_open_app` y `os_window_control` para cada ventana e informa del resultado real devuelto por las herramientas.',
      '',
      integrationsSummary,
      '',
      memoryContext
    ]
      .filter(Boolean)
      .join('\n');
  }

  async tryFastReflexTool(userPrompt) {
    let norm = String(userPrompt || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/^[¿¡.,;:!?"'\s]+|[.,;:!?"'\s]+$/g, '')
      .trim();

    if (!norm) return null;

    const prefixes = [
      /^(?:oye|hola|ey|hey|buenas|iris|por\s+favor|porfa|vale|venga|si|claro|ok)[,\s]+/i,
      /^(?:me\s+puedes|me\s+podrias|puedes|podrias|quiero\s+que\s+me|quiero\s+que)[,\s]+/i
    ];
    let changed = true;
    while (changed) {
      changed = false;
      for (const re of prefixes) {
        const next = norm.replace(re, '').trim();
        if (next && next !== norm) {
          norm = next;
          changed = true;
        }
      }
    }
    norm = norm.replace(/\s+(?:por\s+favor|porfa|ahora\s+mismo|ahora|ya)$/i, '').trim();

    const isVideoOrClipRequest =
      /^(?:buscame|busca|buscar|encuentrame|encuentra|ponme|pon|poner|abreme|abre|abrir|muestrame|ensename|quiero\s+ver)\s+(?:el\s+|un\s+|algun\s+|los\s+)?(?:clip|clips|video|videos|short|shorts)\b/i.test(
        norm
      ) ||
      (/^(?:buscame|busca|buscar|encuentrame|encuentra|ponme|pon|poner|abreme|abre|abrir|muestrame|ensename|quiero\s+ver)\b/i.test(
        norm
      ) &&
        /\b(?:en\s+youtube|clip\s+donde|clip\s+de|clip\s+en|video\s+donde|video\s+de|short\s+de|short\s+donde)\b/i.test(
          norm
        ));

    if (isVideoOrClipRequest) {
      const execResult = await toolsRegistry.executeTool('youtube_search_play', { query: userPrompt }, this);
      const reply = execResult?.fallbackReply || 'Abriendo el vídeo en YouTube.';
      this.pushConversationTurn(userPrompt, reply);
      return {
        reply,
        artifact: execResult?.artifact || null,
        expression: execResult?.expression || 'Feliz'
      };
    }

    const moveMonitorMatch = norm.match(
      /^(?:mueve(?:me)?|muevas|mover(?:me)?|mueble|pasa(?:me)?|pases|pasar(?:me)?|lleva(?:me)?|lleves|llevar(?:me)?|pon(?:me)?|pongas|poner(?:me)?|cambia(?:me)?|cambies|cambiar(?:me)?)\s+(.+?)\s+(?:a|al|en|hacia|para)\s+(?:(?:mi|tu|la|el)\s+)?(?:(segunda|segundo|2a?|secundaria|secundario|otra|otro|siguiente|primera|primer|1a?|principal|izquierda|derecha)\s+(?:pantalla|monitor)|(?:pantalla|monitor)\s+(?:(?:de\s+la|del|de)\s+)?(2|1|dos|uno|primera|primer|primero|segunda|segundo|principal|secundario|secundaria|izquierda|izquierdo|derecha|derecho|otra|otro))$/i
    );
    if (moveMonitorMatch && !/\b(?:pantalla|monitor)\b|\s+y\s+/i.test(moveMonitorMatch[1])) {
      const targetApp = moveMonitorMatch[1].trim();
      const targetMonRaw = moveMonitorMatch[2] || moveMonitorMatch[3] || '2';
      let mon = '2';
      if (/^(1|1a|uno|primera|primer|primero|principal)$/i.test(targetMonRaw)) mon = '1';
      else if (/^(2|2a|dos|segunda|segundo|secundaria|secundario)$/i.test(targetMonRaw)) mon = '2';
      else if (/^izquierd[ao]$/i.test(targetMonRaw)) mon = 'left';
      else if (/^derech[ao]$/i.test(targetMonRaw)) mon = 'right';
      else if (/^(otra|otro|siguiente)$/i.test(targetMonRaw)) mon = 'other';

      const execResult = await toolsRegistry.executeTool(
        'os_window_control',
        { action: 'move_monitor', appName: targetApp, monitor: mon },
        this
      );
      const reply = execResult?.fallbackReply || 'Listo.';
      this.pushConversationTurn(userPrompt, reply);
      return {
        reply,
        artifact: null,
        expression: execResult?.expression || 'Feliz'
      };
    }

    if (
      /^(?:minimiza(?:me)?|minimizar(?:me)?)\s+(?:todas\s+las\s+ventanas|todo)$|^(?:muestra(?:me)?|mostrar|ve\s+al)\s+(?:el\s+)?escritorio$/i.test(
        norm
      )
    ) {
      const execResult = await toolsRegistry.executeTool(
        'os_window_control',
        { action: 'minimize_all', appName: 'all' },
        this
      );
      const reply = execResult?.fallbackReply || 'He minimizado todas las ventanas.';
      this.pushConversationTurn(userPrompt, reply);
      return {
        reply,
        artifact: null,
        expression: execResult?.expression || 'Feliz'
      };
    }

    const snapSideMatch = norm.match(
      /^(?:pon(?:me)?|poner(?:me)?|ajusta(?:me)?|ajustar(?:me)?|mueve(?:me)?|mover(?:me)?|lleva(?:me)?|llevar(?:me)?)\s+(.+?)\s+(?:a\s+la\s+|en\s+la\s+|hacia\s+la\s+)?(?:mitad\s+)?(izquierda|derecha)$/i
    );
    if (snapSideMatch) {
      const targetApp = snapSideMatch[1].trim();
      const sideAction = snapSideMatch[2].toLowerCase() === 'izquierda' ? 'snap_left' : 'snap_right';
      const execResult = await toolsRegistry.executeTool(
        'os_window_control',
        { action: sideAction, appName: targetApp },
        this
      );
      const reply = execResult?.fallbackReply || 'Listo.';
      this.pushConversationTurn(userPrompt, reply);
      return {
        reply,
        artifact: null,
        expression: execResult?.expression || 'Feliz'
      };
    }

    const windowActionMatch = norm.match(
      /^(?:(cierra(?:me)?|cerrar(?:me)?|quita(?:me)?|quitar(?:me)?|mata(?:r)?|termina(?:r)?)|(minimiza(?:me)?|minimizar(?:me)?)|(maximiza(?:me)?|maximizar(?:me)?|agranda(?:me)?|agrandar(?:me)?)|(restaura(?:me)?|restaurar(?:me)?|enfoca(?:r)?|trae\s+al\s+frente|abre(?:me)?\s+la\s+ventana\s+de))\s+(?:la\s+aplicacion\s+de\s+|la\s+app\s+de\s+|la\s+ventana\s+de\s+|el\s+programa\s+de\s+|el\s+|la\s+)?(.+)$/i
    );
    if (windowActionMatch && !/^(?:sesion|el\s+pc|el\s+ordenador|windows|equipo)$/i.test(windowActionMatch[5].trim())) {
      const winAction = windowActionMatch[1]
        ? 'close'
        : windowActionMatch[2]
          ? 'minimize'
          : windowActionMatch[3]
            ? 'maximize'
            : 'restore';
      const targetApp = windowActionMatch[5].trim();
      const execResult = await toolsRegistry.executeTool(
        'os_window_control',
        { action: winAction, appName: targetApp },
        this
      );
      const reply = execResult?.fallbackReply || 'Listo.';
      const closedSpotify = winAction === 'close' && /\bspotify\b/i.test(targetApp);
      this.pushConversationTurn(userPrompt, reply);
      return {
        reply,
        artifact: null,
        expression: execResult?.expression || 'Feliz',
        ...(closedSpotify ? { isSpotifyAction: false, isSpotifyPause: true } : {})
      };
    }

    if (norm.split(/\s+/).length > 11) {
      return null;
    }

    const isSpotifyTarget = /\bspotify\b/.test(norm);
    const target = isSpotifyTarget ? 'spotify' : 'system';
    const volTargetOpt =
      '(?:\\s+(?:del|de\\s+mi|de|en)\\s+(?:ordenador|pc|sistema|equipo|windows|computadora|portatil|spotify))?';

    let action = null;
    let volumePercent;

    const volSetMatch = norm.match(
      new RegExp(
        `^(?:(?:pon|poner|ajusta|ajustar|baja|bajar|sube|subir|deja|dejar|cambia|cambiar)\\s+)?(?:el\\s+)?volumen${volTargetOpt}\\s+(?:al|a)\\s+(\\d{1,3})\\s*%?${volTargetOpt}$`
      )
    );
    if (volSetMatch) {
      action = 'set_volume';
      volumePercent = Math.max(0, Math.min(100, Number(volSetMatch[1])));
    } else if (
      new RegExp(
        `^(?:sube|subir|subelo|mas)(?:\\s+un\\s+(?:poco|poquito))?\\s+(?:el\\s+)?(?:volumen|la\\s+musica|el\\s+sonido)${volTargetOpt}$|^sube\\s+volumen${volTargetOpt}$|^mas\\s+volumen${volTargetOpt}$`
      ).test(norm)
    ) {
      action = 'vol_up';
    } else if (
      new RegExp(
        `^(?:baja|bajar|bajalo|menos)(?:\\s+un\\s+(?:poco|poquito))?\\s+(?:el\\s+)?(?:volumen|la\\s+musica|el\\s+sonido)${volTargetOpt}$|^baja\\s+volumen${volTargetOpt}$|^menos\\s+volumen${volTargetOpt}$`
      ).test(norm)
    ) {
      action = 'vol_down';
    } else if (
      new RegExp(
        `^(?:silencia|silenciar|mute|mutea)(?:\\s+(?:el\\s+(?:volumen|sonido|ordenador|pc|equipo|sistema)|la\\s+musica))?${volTargetOpt}$`
      ).test(norm)
    ) {
      action = 'mute';
    } else if (
      /^(?:pausa|pausar|para|parar|deten|detener)(?:\s+(?:la\s+musica|spotify|la\s+cancion|la\s+reproduccion))?$/.test(
        norm
      )
    ) {
      action = 'pause';
    } else if (
      /^(?:reanuda|reanudar|continua|continuar|sigue|seguir|play)(?:\s+(?:con\s+)?(?:la\s+musica|spotify|la\s+cancion|la\s+reproduccion))?$/.test(
        norm
      )
    ) {
      action = 'resume';
    } else if (
      /^(?:siguiente|pasa|pasar|salta|saltar)(?:\s+(?:de\s+|a\s+la\s+)?(?:cancion|tema|pista))?$|^siguiente\s+cancion$/.test(
        norm
      )
    ) {
      action = 'next';
    } else if (
      /^(?:anterior|atras|volver)(?:\s+(?:de\s+|a\s+la\s+)?(?:cancion|tema|pista))?$|^cancion\s+anterior$/.test(
        norm
      )
    ) {
      action = 'previous';
    }

    if (!action) return null;

    const isVolumeCmd = ['set_volume', 'vol_up', 'vol_down', 'mute'].includes(action);
    const toolName = isVolumeCmd && target === 'system' ? 'os_volume_control' : 'spotify_control';
    const toolArgs = volumePercent !== undefined ? { action, volumePercent, target } : { action, target };
    const execResult = await toolsRegistry.executeTool(toolName, toolArgs, this);
    const reply = execResult?.fallbackReply || 'Listo.';
    this.pushConversationTurn(userPrompt, reply);
    return {
      reply,
      artifact: execResult?.artifact || null,
      expression: execResult?.expression || 'Feliz',
      isSpotifyAction: toolName.startsWith('spotify_') || isSpotifyTarget,
      isSpotifyVolumeChange: toolName === 'spotify_control' && isVolumeCmd,
      isSpotifyPause: toolName === 'spotify_control' && action === 'pause'
    };
  }

  async handleUserPrompt(userPrompt) {
    const t0 = performance.now();
    const detectedKey = this.detectApiKeyOnly(userPrompt);

    if (detectedKey) {
      const totalKeys = this.saveApiKey(detectedKey);
      return {
        reply: `API Key detectada y guardada (${totalKeys} activa${totalKeys > 1 ? 's' : ''} en rotación).`,
        expression: 'Feliz',
        postExpression: 'Disponible',
        latencyMs: Math.round(performance.now() - t0)
      };
    }

    const fastReflexResult = await this.tryFastReflexTool(userPrompt);
    if (fastReflexResult) {
      return {
        reply: fastReflexResult.reply,
        artifact: fastReflexResult.artifact || null,
        expression: fastReflexResult.expression || 'Feliz',
        postExpression: 'Disponible',
        latencyMs: Math.round(performance.now() - t0),
        isSpotifyAction: Boolean(fastReflexResult.isSpotifyAction),
        isSpotifyVolumeChange: Boolean(fastReflexResult.isSpotifyVolumeChange),
        isSpotifyPause: Boolean(fastReflexResult.isSpotifyPause)
      };
    }

    const systemInstruction = this.buildAgentSystemInstruction();

    let agentResult = null;
    try {
      agentResult = await this.callGeminiAgent(userPrompt, systemInstruction);
    } catch (err) {
      if (err?.message !== 'NO_API_KEY' && err?.message !== 'ALL_GEMINI_SLOTS_EXHAUSTED') {
        console.warn('[IRIS Gemini Agent fallback]', err?.message || err);
      }
      agentResult = await this.callOllamaAgent(userPrompt, systemInstruction);
    }

    return {
      reply: agentResult.reply,
      artifact: agentResult.artifact || null,
      expression: agentResult.expression || 'Respondiendo',
      postExpression: 'Disponible',
      latencyMs: Math.round(performance.now() - t0),
      isSpotifyAction: Boolean(agentResult.isSpotifyAction),
      isSpotifyVolumeChange: Boolean(agentResult.isSpotifyVolumeChange),
      isSpotifyPause: Boolean(agentResult.isSpotifyPause)
    };
  }

  async requestGeminiAgentParts({ systemInstruction, contents, declarations }) {
    this.config = this.loadConfig();
    const apiKeys = this.config.gemini.apiKeys || [];
    if (apiKeys.length === 0) {
      throw new Error('NO_API_KEY');
    }

    const configuredModels = this.config.gemini.thinkingTextModels || [
      'gemini-flash-lite-latest',
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-2.5-flash'
    ];
    const fastModels = configuredModels.filter((m) => !String(m).includes('pro'));
    const models =
      fastModels.length > 0
        ? fastModels
        : ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
    const cooldownMs = this.config.gemini.cooldownMsOnQuotaExhausted || 60000;
    const now = Date.now();

    for (let keyIdx = 0; keyIdx < apiKeys.length; keyIdx++) {
      const apiKey = apiKeys[keyIdx];

      for (const model of models) {
        const slotKey = `${keyIdx}:${model}`;
        const exhaustedUntil = this.quotaCooldowns.get(slotKey) || 0;
        if (now < exhaustedUntil) {
          continue;
        }

        const endpoints = [
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
        ];

        for (const url of endpoints) {
          try {
            const genConfig = {
              temperature: 0.35,
              maxOutputTokens: 768
            };
            if (model.includes('2.5-flash')) {
              genConfig.thinkingConfig = { thinkingBudget: 0 };
            }

            const body = {
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents,
              generationConfig: genConfig
            };

            if (Array.isArray(declarations) && declarations.length > 0) {
              body.tools = [{ functionDeclarations: declarations }];
            }

            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(4500)
            });

            if (res.status === 429 || res.status === 503 || res.status === 404 || res.status === 403) {
              this.quotaCooldowns.set(slotKey, Date.now() + cooldownMs);
              break;
            }

            if (!res.ok) continue;

            const data = await res.json();
            const parts = data?.candidates?.[0]?.content?.parts;
            if (Array.isArray(parts) && parts.length > 0) {
              return parts;
            }
          } catch {
            // try next endpoint/model
          }
        }
      }
    }

    throw new Error('ALL_GEMINI_SLOTS_EXHAUSTED');
  }

  async executeOrderedToolCalls(calls, state) {
    const getPriority = (name) => {
      if (name === 'os_open_app' || name === 'spotify_play' || name === 'youtube_search_play') return 0;
      if (name === 'os_window_control') return 2;
      return 1;
    };

    const positioningActions = new Set(['move_monitor', 'maximize', 'restore', 'focus', 'snap_left', 'snap_right']);
    const windowControlTokens = new Set();
    for (const call of calls) {
      if (
        call.name === 'os_window_control' &&
        positioningActions.has(String(call.args?.action || '').toLowerCase()) &&
        call.args?.appName
      ) {
        const resolved = resolveWindowAppAliases(String(call.args.appName));
        for (const tok of resolved.tokens) {
          if (tok && !tok.startsWith('__')) windowControlTokens.add(tok);
        }
      }
    }

    const isRedundantOpenCall = (name, args) => {
      if (name !== 'os_open_app' || windowControlTokens.size === 0) return false;
      const resolved = resolveWindowAppAliases(String(args?.appName || ''));
      return resolved.tokens.some((tok) => windowControlTokens.has(tok));
    };

    const indexed = calls.map((call, idx) => ({ call, idx, prio: getPriority(call.name) }));
    indexed.sort((a, b) => a.prio - b.prio || a.idx - b.idx);

    const resultsByIdx = new Array(calls.length);
    let launchedSomething = false;
    let waitedForLaunch = false;

    for (const item of indexed) {
      const { name, args } = item.call;
      if (isRedundantOpenCall(name, args)) {
        state.executedAnyTool = true;
        state.latestExpression = 'Feliz';
        state.latestFallbackReply = 'Abierto.';
        resultsByIdx[item.idx] = {
          data: { ok: true, appName: args?.appName || '', reply: 'Abierto.' },
          fallbackReply: 'Abierto.',
          expression: 'Feliz'
        };
        continue;
      }

      if (name === 'os_window_control' && launchedSomething && !waitedForLaunch) {
        waitedForLaunch = true;
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }

      const execResult = await toolsRegistry.executeTool(name, args || {}, this);
      state.executedAnyTool = true;

      if (name === 'os_open_app' || name === 'spotify_play') {
        launchedSomething = true;
      }

      if (name.startsWith('spotify_')) {
        state.isSpotifyAction = true;
        if (
          name === 'spotify_control' &&
          ['set_volume', 'vol_up', 'vol_down', 'mute'].includes(args?.action)
        ) {
          state.isSpotifyVolumeChange = true;
        }
        if (name === 'spotify_control' && args?.action === 'pause') {
          state.isSpotifyPause = true;
        }
      }

      if (execResult.artifact) state.latestArtifact = execResult.artifact;
      if (execResult.expression) state.latestExpression = execResult.expression;
      if (execResult.fallbackReply) state.latestFallbackReply = execResult.fallbackReply;

      resultsByIdx[item.idx] = execResult;
    }

    return resultsByIdx;
  }

  async callGeminiAgent(userPrompt, systemInstruction) {
    const declarations = toolsRegistry.getGeminiDeclarations();
    const contents = [
      ...this.conversationHistory.slice(-6).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      { role: 'user', parts: [{ text: userPrompt }] }
    ];

    const state = {
      latestArtifact: null,
      latestExpression: 'Respondiendo',
      latestFallbackReply: '',
      executedAnyTool: false,
      isSpotifyAction: /\bspotify\b/i.test(userPrompt),
      isSpotifyVolumeChange: false,
      isSpotifyPause: false
    };

    for (let round = 0; round < 3; round++) {
      const includeTools = round < 2;
      let candidateParts = null;

      try {
        candidateParts = await this.requestGeminiAgentParts({
          systemInstruction,
          contents,
          declarations: includeTools ? declarations : null
        });
      } catch (err) {
        if (state.executedAnyTool && state.latestFallbackReply) {
          this.pushConversationTurn(userPrompt, state.latestFallbackReply);
          return {
            reply: state.latestFallbackReply,
            artifact: state.latestArtifact,
            expression: state.latestExpression,
            isSpotifyAction: state.isSpotifyAction,
            isSpotifyVolumeChange: state.isSpotifyVolumeChange,
            isSpotifyPause: state.isSpotifyPause
          };
        }
        throw err;
      }

      const fnCallParts = candidateParts.filter((p) => p.functionCall);
      if (fnCallParts.length === 0) {
        const text = candidateParts
          .map((p) => p.text || '')
          .join(' ')
          .trim()
          .replace(/^["']|["']$/g, '');

        const finalReply = text || state.latestFallbackReply;
        if (finalReply) {
          this.pushConversationTurn(userPrompt, finalReply);
          return {
            reply: finalReply,
            artifact: state.latestArtifact,
            expression: state.executedAnyTool ? state.latestExpression : 'Respondiendo',
            isSpotifyAction: state.isSpotifyAction,
            isSpotifyVolumeChange: state.isSpotifyVolumeChange,
            isSpotifyPause: state.isSpotifyPause
          };
        }
        break;
      }

      const batchParts = fnCallParts.slice(0, 6);
      const resultsByIdx = await this.executeOrderedToolCalls(
        batchParts.map((part) => ({
          name: part.functionCall.name,
          args: part.functionCall.args || {}
        })),
        state
      );

      const toolResponses = batchParts.map((part, idx) => ({
        functionResponse: {
          name: part.functionCall.name,
          response: { result: resultsByIdx[idx]?.data ?? { ok: true } }
        }
      }));

      // Skip extra synthesis LLM round for immediate deterministic actions
      if (round === 0 && fnCallParts.length === 1) {
        const meta = toolsRegistry.getToolMeta(fnCallParts[0].functionCall.name);
        if (meta?.directFinal && state.latestFallbackReply) {
          this.pushConversationTurn(userPrompt, state.latestFallbackReply);
          return {
            reply: state.latestFallbackReply,
            artifact: state.latestArtifact,
            expression: state.latestExpression,
            isSpotifyAction: state.isSpotifyAction,
            isSpotifyVolumeChange: state.isSpotifyVolumeChange,
            isSpotifyPause: state.isSpotifyPause
          };
        }
      }

      contents.push({ role: 'model', parts: candidateParts });
      contents.push({ role: 'user', parts: toolResponses });
    }

    if (state.executedAnyTool && state.latestFallbackReply) {
      this.pushConversationTurn(userPrompt, state.latestFallbackReply);
      return {
        reply: state.latestFallbackReply,
        artifact: state.latestArtifact,
        expression: state.latestExpression,
        isSpotifyAction: state.isSpotifyAction,
        isSpotifyVolumeChange: state.isSpotifyVolumeChange,
        isSpotifyPause: state.isSpotifyPause
      };
    }

    throw new Error('ALL_GEMINI_SLOTS_EXHAUSTED');
  }

  extractOllamaToolCalls(message) {
    if (!message) return [];

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const valid = [];
      for (const tc of message.tool_calls) {
        const name = tc?.function?.name;
        if (!name || !toolsRegistry.getToolMeta(name)) continue;
        let args = tc.function.arguments ?? {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        valid.push({ name, args });
      }
      if (valid.length > 0) return valid;
    }

    // Some smaller local models occasionally emit a raw JSON tool call as text content
    const raw = (message.content || '').trim();
    if (!raw) return [];
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
      try {
        const parsed = JSON.parse(cleaned);
        const fnName = parsed.name || parsed.function?.name;
        if (fnName && toolsRegistry.getToolMeta(fnName)) {
          let args = parsed.arguments ?? parsed.parameters ?? parsed.function?.arguments ?? {};
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          return [{ name: fnName, args }];
        }
      } catch {
        // not a JSON tool call
      }
    }

    return [];
  }

  async postOllamaChat({ model, messages, tools, options }) {
    const baseUrl = this.config.ollama.baseUrl;
    const payload = {
      model,
      messages,
      stream: false,
      keep_alive: -1,
      options: options || {
        temperature: 0.35,
        num_predict: 360,
        top_p: 0.9
      }
    };
    if (Array.isArray(tools) && tools.length > 0) {
      payload.tools = tools;
    }

    return await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async callOllamaAgent(userPrompt, systemInstruction) {
    const modelsToTry = [
      this.config.ollama.primaryModel,
      ...(this.config.ollama.fallbackModels || [])
    ].filter(Boolean);

    const ollamaTools = toolsRegistry.getOllamaTools();
    const messages = [
      { role: 'system', content: systemInstruction },
      ...this.conversationHistory.slice(-6),
      { role: 'user', content: userPrompt }
    ];

    for (const model of modelsToTry) {
      try {
        let res = await this.postOllamaChat({ model, messages, tools: ollamaTools });
        if (res.status === 400) {
          res = await this.postOllamaChat({ model, messages, tools: null });
        }
        if (!res.ok) continue;

        const data = await res.json();
        const assistantMessage = data?.message;
        const toolCalls = this.extractOllamaToolCalls(assistantMessage);

        if (toolCalls.length > 0) {
          const state = {
            latestArtifact: null,
            latestExpression: 'Feliz',
            latestFallbackReply: '',
            executedAnyTool: false,
            isSpotifyAction: /\bspotify\b/i.test(userPrompt),
            isSpotifyVolumeChange: false,
            isSpotifyPause: false
          };
          const turnMessages = [
            ...messages,
            {
              role: 'assistant',
              content: assistantMessage?.content || '',
              ...(assistantMessage?.tool_calls ? { tool_calls: assistantMessage.tool_calls } : {})
            }
          ];

          const batchCalls = toolCalls.slice(0, 6);
          const resultsByIdx = await this.executeOrderedToolCalls(batchCalls, state);

          for (let idx = 0; idx < batchCalls.length; idx++) {
            turnMessages.push({
              role: 'tool',
              tool_name: batchCalls[idx].name,
              content: JSON.stringify(resultsByIdx[idx]?.data ?? { ok: true })
            });
          }

          if (toolCalls.length === 1) {
            const meta = toolsRegistry.getToolMeta(toolCalls[0].name);
            if (meta?.directFinal && state.latestFallbackReply) {
              this.pushConversationTurn(userPrompt, state.latestFallbackReply);
              return {
                reply: state.latestFallbackReply,
                artifact: state.latestArtifact,
                expression: state.latestExpression,
                isSpotifyAction: state.isSpotifyAction,
                isSpotifyVolumeChange: state.isSpotifyVolumeChange,
                isSpotifyPause: state.isSpotifyPause
              };
            }
          }

          try {
            const synthRes = await this.postOllamaChat({ model, messages: turnMessages, tools: null });
            if (synthRes.ok) {
              const synthData = await synthRes.json();
              const synthText = (synthData?.message?.content || '')
                .trim()
                .replace(/^["']|["']$/g, '');
              if (synthText && !synthText.startsWith('{')) {
                this.pushConversationTurn(userPrompt, synthText);
                return {
                  reply: synthText,
                  artifact: state.latestArtifact,
                  expression: state.latestExpression,
                  isSpotifyAction: state.isSpotifyAction,
                  isSpotifyVolumeChange: state.isSpotifyVolumeChange,
                  isSpotifyPause: state.isSpotifyPause
                };
              }
            }
          } catch {
            // fall back to deterministic tool summary
          }

          if (state.latestFallbackReply) {
            this.pushConversationTurn(userPrompt, state.latestFallbackReply);
            return {
              reply: state.latestFallbackReply,
              artifact: state.latestArtifact,
              expression: state.latestExpression,
              isSpotifyAction: state.isSpotifyAction,
              isSpotifyVolumeChange: state.isSpotifyVolumeChange,
              isSpotifyPause: state.isSpotifyPause
            };
          }
        }

        const content = (assistantMessage?.content || '').trim().replace(/^["']|["']$/g, '');
        if (content) {
          this.pushConversationTurn(userPrompt, content);
          return {
            reply: content,
            artifact: null,
            expression: 'Respondiendo'
          };
        }
      } catch {
        // try next local model
      }
    }

    return {
      reply: 'Ahora mismo no pude conectar con Gemini ni con el modelo local. Revisa tu conexión o que Ollama esté iniciado.',
      artifact: null,
      expression: 'Disponible'
    };
  }

  async askLocalLlama(userPrompt, systemInstruction) {
    const modelsToTry = [
      this.config.ollama.primaryModel,
      ...(this.config.ollama.fallbackModels || [])
    ].filter(Boolean);

    const messages = [
      { role: 'system', content: systemInstruction },
      ...this.conversationHistory.slice(-4),
      { role: 'user', content: userPrompt }
    ];

    for (const model of modelsToTry) {
      try {
        const res = await this.postOllamaChat({
          model,
          messages,
          tools: null,
          options: {
            temperature: 0.4,
            num_predict: 280,
            top_p: 0.9
          }
        });

        if (!res.ok) continue;
        const data = await res.json();
        const content = (data?.message?.content || '').trim().replace(/^["']|["']$/g, '');
        if (content) {
          this.pushConversationTurn(userPrompt, content);
          return content;
        }
      } catch {
        // try next model
      }
    }

    return 'Listo, dime cómo quieres que proceda.';
  }

  /**
   * Executes deep thinking / recommendation / code / autonomous problem-solving
   * and returns BOTH a voice reply and an interactive Artifact when useful!
   */
  async executeThinkingTask(userPrompt) {
    const structuredPrompt = `Eres Iris, un asistente personal en Windows con capacidad de crear "Artifacts" interactivos y buscarse la vida.
REGLA CRÍTICA: NUNCA mientas diciendo que ya has reproducido algo o ejecutado algo si no tienes la integración. Si el usuario pide algo que necesita una API (ej. Spotify, Notion, etc.) o se puede resolver con botones interactivos, enlaces o código, genera un Artifact útil.

Devuelve ÚNICAMENTE un JSON válido (sin bloques markdown \`\`\`json) con esta estructura exacta:
{
  "reply": "Tu respuesta hablada corta en español (1 o 2 frases naturales sin emojis)",
  "artifact": {
    "type": "list" | "code" | "integration",
    "badge": "Etiqueta corta (ej. Recomendaciones / Código / Acción)",
    "title": "Título del artifact",
    "subtitle": "Subtítulo opcional",
    "code": "Solo si type es code: el código o comando completo",
    "items": [
      { "label": "Texto del elemento (ej. Kanye West - Runaway)", "actionType": "play" | "search" | "copy", "query": "Kanye West Runaway" }
    ]
  }
}
Si la pregunta no necesita artifact, pon "artifact": null.

Petición del usuario: ${userPrompt}`;

    try {
      const raw = await this.callGeminiPool({
        poolType: 'thinking',
        prompt: structuredPrompt,
        imageBase64: null
      });

      const parsed = this.tryParseArtifactJson(raw);
      if (parsed && parsed.reply) {
        this.conversationHistory.push({ role: 'user', content: userPrompt });
        this.conversationHistory.push({ role: 'assistant', content: parsed.reply });
        return {
          reply: parsed.reply,
          artifact: parsed.artifact || null,
          expression: 'Feliz'
        };
      }

      this.conversationHistory.push({ role: 'user', content: userPrompt });
      this.conversationHistory.push({ role: 'assistant', content: raw });
      return {
        reply: raw,
        artifact: null,
        expression: 'Feliz'
      };
    } catch {
      const fallbackLocal = await this.askLocalLlama(
        userPrompt,
        'Eres Iris. Responde en español en 1 o 2 frases claras y honestas, sin fingir acciones que no hayas ejecutado.'
      );
      return {
        reply: fallbackLocal,
        artifact: null,
        expression: 'Respondiendo'
      };
    }
  }

  async executeVisionTask(userPrompt) {
    try {
      const screenBase64 = await this.captureScreenBase64();
      const visionAnswer = await this.callGeminiPool({
        poolType: 'vision',
        prompt: `Eres Iris, el asistente de escritorio del usuario. Analiza esta captura de su pantalla y responde directamente a su pregunta en español, en primera persona, de forma natural y concisa (1 a 3 frases, sin emojis). Ignora cualquier barra superior de asistente si apareciera y céntrate solo en el contenido principal que está viendo el usuario.\n\nPregunta del usuario: ${userPrompt}`,
        imageBase64: screenBase64
      });

      this.conversationHistory.push({ role: 'user', content: userPrompt });
      this.conversationHistory.push({ role: 'assistant', content: visionAnswer });

      return {
        reply: visionAnswer,
        artifact: {
          type: 'vision',
          badge: 'Captura Analizada',
          title: 'Visión de Pantalla Activa',
          subtitle: visionAnswer,
          imageDataUrl: `data:image/jpeg;base64,${screenBase64}`,
          actions: [
            { label: 'Copiar análisis', copyText: visionAnswer }
          ]
        },
        expression: 'Feliz'
      };
    } catch {
      return {
        reply: 'No pude analizar la pantalla en este momento. Revisa tu conexión o la clave de Gemini en Configuración.',
        artifact: null,
        expression: 'Disponible'
      };
    }
  }

  tryParseArtifactJson(rawText) {
    try {
      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        return JSON.parse(cleaned.slice(start, end + 1));
      }
    } catch {
      // fallback to plain text
    }
    return null;
  }

  async executeArtifactAction(actionPayload) {
    if (!actionPayload) return { reply: 'Acción completada.' };

    if (actionPayload.url) {
      exec(`start "" "${actionPayload.url}"`);
      return { reply: 'Abierto ahora mismo.' };
    }
    if (actionPayload.cmd && actionPayload.cmd.startsWith('media:')) {
      const sub = actionPayload.cmd.split(':')[1];
      const msg = await executeMediaControl(sub);
      return { reply: msg };
    }
    if (actionPayload.actionType === 'spotify_play' && actionPayload.spotifyItem) {
      const item = actionPayload.spotifyItem;
      const res = await spotifyApi.playItem(item);
      const title = item.subtitle ? `${item.name} — ${item.subtitle}` : item.name;
      if (res.ok) return { reply: `Reproduciendo "${title}" en Spotify.`, isSpotifyAction: true };
      const { launchSpotifyWithCtrlSpace } = require('./agent-executor');
      launchSpotifyWithCtrlSpace(item.uri);
      return { reply: `Poniendo "${title}" en Spotify.`, isSpotifyAction: true };
    }
    if (actionPayload.actionType === 'play' && actionPayload.query) {
      const playRes = await playMusicOrVideo(actionPayload.query);
      return { ...playRes, isSpotifyAction: true };
    }
    if (actionPayload.actionType === 'search' && actionPayload.query) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(actionPayload.query)}`;
      exec(`start "" "${url}"`);
      return { reply: `He buscado "${actionPayload.query}" en tu navegador.` };
    }
    return { reply: 'Listo.' };
  }

  async captureScreenBase64() {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 }
    });
    if (!sources || sources.length === 0) {
      throw new Error('No screen source available');
    }
    const jpegBuffer = sources[0].thumbnail.toJPEG(78);
    return jpegBuffer.toString('base64');
  }

  async callGeminiPool({ poolType, prompt, imageBase64 }) {
    this.config = this.loadConfig();
    const apiKeys = this.config.gemini.apiKeys || [];
    if (apiKeys.length === 0) {
      throw new Error('NO_API_KEY');
    }

    const models =
      poolType === 'vision'
        ? this.config.gemini.visionImageModels
        : this.config.gemini.thinkingTextModels;

    const cooldownMs = this.config.gemini.cooldownMsOnQuotaExhausted || 60000;
    const now = Date.now();

    for (let keyIdx = 0; keyIdx < apiKeys.length; keyIdx++) {
      const apiKey = apiKeys[keyIdx];

      for (const model of models) {
        const slotKey = `${keyIdx}:${model}`;
        const exhaustedUntil = this.quotaCooldowns.get(slotKey) || 0;
        if (now < exhaustedUntil) {
          continue;
        }

        const endpoints = [
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
        ];

        for (const url of endpoints) {
          try {
            const parts = [{ text: prompt }];
            if (imageBase64) {
              parts.push({
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: imageBase64
                }
              });
            }

            const genConfig = {
              temperature: 0.4,
              maxOutputTokens: 1024
            };
            if (model.includes('2.5-flash')) {
              genConfig.thinkingConfig = { thinkingBudget: 0 };
            }

            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts }],
                generationConfig: genConfig
              }),
              signal: AbortSignal.timeout(4500)
            });

            if (res.status === 429 || res.status === 503 || res.status === 404 || res.status === 403) {
              this.quotaCooldowns.set(slotKey, Date.now() + cooldownMs);
              break;
            }

            if (!res.ok) continue;

            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts
              ?.map((p) => p.text || '')
              .join(' ')
              .trim();

            if (text) {
              return text;
            }
          } catch {
            // try next endpoint/model
          }
        }
      }
    }

    throw new Error('ALL_GEMINI_SLOTS_EXHAUSTED');
  }
}

module.exports = { IrisAIOrchestrator };
