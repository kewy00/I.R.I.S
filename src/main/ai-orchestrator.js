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
const { openWindowsApp, getSystemStatsSummary } = require('./os-tools');
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

    if (norm.split(/\s+/).length > 8) {
      return null;
    }

    let action = null;
    let volumePercent;

    const volSetMatch = norm.match(
      /^(?:(?:pon|poner|ajusta|ajustar|baja|bajar|sube|subir|deja|dejar)\s+)?(?:el\s+)?volumen\s+(?:al|a)\s+(\d{1,3})\s*%?$/
    );
    if (volSetMatch) {
      action = 'set_volume';
      volumePercent = Math.max(0, Math.min(100, Number(volSetMatch[1])));
    } else if (
      /^(?:sube|subir|subelo|mas)(?:\s+un\s+(?:poco|poquito))?\s+(?:el\s+)?(?:volumen|la\s+musica|el\s+sonido)$|^sube\s+volumen$|^mas\s+volumen$/.test(
        norm
      )
    ) {
      action = 'vol_up';
    } else if (
      /^(?:baja|bajar|bajalo|menos)(?:\s+un\s+(?:poco|poquito))?\s+(?:el\s+)?(?:volumen|la\s+musica|el\s+sonido)$|^baja\s+volumen$|^menos\s+volumen$/.test(
        norm
      )
    ) {
      action = 'vol_down';
    } else if (
      /^(?:silencia|silenciar|mute|mutea)(?:\s+(?:el\s+volumen|el\s+sonido|la\s+musica|el\s+pc))?$/.test(norm)
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

    const toolArgs = volumePercent !== undefined ? { action, volumePercent } : { action };
    const execResult = await toolsRegistry.executeTool('spotify_control', toolArgs, this);
    const reply = execResult?.fallbackReply || 'Listo.';
    this.pushConversationTurn(userPrompt, reply);
    return {
      reply,
      artifact: execResult?.artifact || null,
      expression: execResult?.expression || 'Feliz'
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
        latencyMs: Math.round(performance.now() - t0)
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
      latencyMs: Math.round(performance.now() - t0)
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

  async callGeminiAgent(userPrompt, systemInstruction) {
    const declarations = toolsRegistry.getGeminiDeclarations();
    const contents = [
      ...this.conversationHistory.slice(-6).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      { role: 'user', parts: [{ text: userPrompt }] }
    ];

    let latestArtifact = null;
    let latestExpression = 'Respondiendo';
    let latestFallbackReply = '';
    let executedAnyTool = false;

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
        if (executedAnyTool && latestFallbackReply) {
          this.pushConversationTurn(userPrompt, latestFallbackReply);
          return {
            reply: latestFallbackReply,
            artifact: latestArtifact,
            expression: latestExpression
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

        const finalReply = text || latestFallbackReply;
        if (finalReply) {
          this.pushConversationTurn(userPrompt, finalReply);
          return {
            reply: finalReply,
            artifact: latestArtifact,
            expression: executedAnyTool ? latestExpression : 'Respondiendo'
          };
        }
        break;
      }

      const toolResponses = [];
      for (const part of fnCallParts.slice(0, 4)) {
        const fnName = part.functionCall.name;
        const fnArgs = part.functionCall.args || {};
        const execResult = await toolsRegistry.executeTool(fnName, fnArgs, this);
        executedAnyTool = true;

        if (execResult.artifact) {
          latestArtifact = execResult.artifact;
        }
        if (execResult.expression) {
          latestExpression = execResult.expression;
        }
        if (execResult.fallbackReply) {
          latestFallbackReply = execResult.fallbackReply;
        }

        toolResponses.push({
          functionResponse: {
            name: fnName,
            response: { result: execResult.data ?? { ok: true } }
          }
        });
      }

      // Skip extra synthesis LLM round for immediate deterministic actions
      if (round === 0 && fnCallParts.length === 1) {
        const meta = toolsRegistry.getToolMeta(fnCallParts[0].functionCall.name);
        if (meta?.directFinal && latestFallbackReply) {
          this.pushConversationTurn(userPrompt, latestFallbackReply);
          return {
            reply: latestFallbackReply,
            artifact: latestArtifact,
            expression: latestExpression
          };
        }
      }

      contents.push({ role: 'model', parts: candidateParts });
      contents.push({ role: 'user', parts: toolResponses });
    }

    if (executedAnyTool && latestFallbackReply) {
      this.pushConversationTurn(userPrompt, latestFallbackReply);
      return {
        reply: latestFallbackReply,
        artifact: latestArtifact,
        expression: latestExpression
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
          let latestArtifact = null;
          let latestExpression = 'Feliz';
          let latestFallbackReply = '';
          const turnMessages = [
            ...messages,
            {
              role: 'assistant',
              content: assistantMessage?.content || '',
              ...(assistantMessage?.tool_calls ? { tool_calls: assistantMessage.tool_calls } : {})
            }
          ];

          for (const tc of toolCalls.slice(0, 4)) {
            const execResult = await toolsRegistry.executeTool(tc.name, tc.args, this);
            if (execResult.artifact) latestArtifact = execResult.artifact;
            if (execResult.expression) latestExpression = execResult.expression;
            if (execResult.fallbackReply) latestFallbackReply = execResult.fallbackReply;

            turnMessages.push({
              role: 'tool',
              tool_name: tc.name,
              content: JSON.stringify(execResult.data ?? { ok: true })
            });
          }

          if (toolCalls.length === 1) {
            const meta = toolsRegistry.getToolMeta(toolCalls[0].name);
            if (meta?.directFinal && latestFallbackReply) {
              this.pushConversationTurn(userPrompt, latestFallbackReply);
              return {
                reply: latestFallbackReply,
                artifact: latestArtifact,
                expression: latestExpression
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
                  artifact: latestArtifact,
                  expression: latestExpression
                };
              }
            }
          } catch {
            // fall back to deterministic tool summary
          }

          if (latestFallbackReply) {
            this.pushConversationTurn(userPrompt, latestFallbackReply);
            return {
              reply: latestFallbackReply,
              artifact: latestArtifact,
              expression: latestExpression
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
      if (res.ok) return { reply: `Reproduciendo "${title}" en Spotify.` };
      const { launchSpotifyWithCtrlSpace } = require('./agent-executor');
      launchSpotifyWithCtrlSpace(item.uri);
      return { reply: `Poniendo "${title}" en Spotify.` };
    }
    if (actionPayload.actionType === 'play' && actionPayload.query) {
      return await playMusicOrVideo(actionPayload.query);
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
