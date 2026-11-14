/**
 * Iris / Bar Interactive Controller
 * - Persistent chat history saved to disk (`config/chat-history.json`) & localStorage
 * - Full scrollable message stream: scroll up with mouse wheel to read older messages
 * - Settings panel: Accent Color, Local Ollama Model selector, Gemini API Keys with Show/Hide
 * - Custom Right-Click Context Menu: Copiar, Pegar, Cortar, Seleccionar todo
 */
import { renderIrisAvatarHTML, renderSpotifyDiscHTML, attachIrisEyePhysics } from './iris-avatar.js';
import { IrisReflexEngine } from '../engine/reflex-engine.js';

export async function initIrisApp() {
  const avatarSlot = document.getElementById('iris-main-avatar-slot');
  const barEl = document.getElementById('iris-main-bar');
  const chatStreamEl = document.getElementById('iris-chat-stream');
  const compactTitleEl = document.getElementById('iris-compact-title');
  const compactStatusEl = document.getElementById('iris-compact-status');

  const inputDrawerEl = document.getElementById('iris-input-drawer');
  const textInputEl = document.getElementById('iris-text-input');
  const sendBtnEl = document.getElementById('iris-send-btn');
  const artifactCardEl = document.getElementById('iris-artifact-card');

  const settingsPanelEl = document.getElementById('iris-settings-panel');
  const btnToggleCompact = document.getElementById('btn-toggle-compact');
  const dndToggleEl = document.getElementById('iris-dnd-toggle');
  const autoStartToggleEl = document.getElementById('iris-autostart-toggle');
  const btnToggleInput = document.getElementById('btn-toggle-input');
  const btnToggleSettings = document.getElementById('btn-toggle-settings');
  const btnScrollBottom = document.getElementById('btn-scroll-bottom');

  // Settings controls
  const colorSwatches = document.querySelectorAll('.iris-color-swatch');
  const customColorInput = document.getElementById('iris-custom-color');
  const modelSelectEl = document.getElementById('iris-model-select');
  const apiKeysListEl = document.getElementById('iris-api-keys-list');
  const newApiInputEl = document.getElementById('iris-new-api-input');
  const btnAddApiKey = document.getElementById('btn-add-api-key');
  const btnToggleApiVisibility = document.getElementById('btn-toggle-api-visibility');

  // Context menu controls
  const contextMenuEl = document.getElementById('iris-context-menu');

  const isElectronDesktop = Boolean(window.irisOS?.isElectron);
  if (!isElectronDesktop) {
    document.body.classList.add('showcase-mode');
  }

  // Load saved conversation history
  let messages = [
    { id: 1, sender: 'user', text: 'Hola, ¿cómo vas?', streaming: false, typing: false },
    { id: 2, sender: 'ai', text: 'Hola, estoy bien', streaming: false, typing: false }
  ];

  if (window.irisOS?.loadHistory) {
    try {
      const saved = await window.irisOS.loadHistory();
      if (Array.isArray(saved) && saved.length > 0) {
        messages = saved;
      }
    } catch {
      // default
    }
  } else {
    try {
      const localSaved = JSON.parse(localStorage.getItem('iris_chat_history') || 'null');
      if (Array.isArray(localSaved) && localSaved.length > 0) {
        messages = localSaved;
      }
    } catch {
      // default
    }
  }

  let nextMsgId = messages.reduce((max, m) => Math.max(max, m.id || 0), 0) + 1;

  function persistHistory() {
    const clean = messages.filter((m) => !m.typing).slice(-100);
    try {
      localStorage.setItem('iris_chat_history', JSON.stringify(clean));
    } catch {
      // ignore
    }
    if (window.irisOS?.saveHistory) {
      window.irisOS.saveHistory(clean);
    }
  }

  function renderMessages(animateLast = false) {
    if (!chatStreamEl) return;

    chatStreamEl.innerHTML = messages
      .map((msg, idx) => {
        const isLast = idx === messages.length - 1;
        const rowClass = msg.sender === 'ai' ? 'from-ai' : 'from-user';
        const animStyle = animateLast && isLast ? '' : 'animation: none;';

        if (msg.typing) {
          return `
            <div class="iris-msg-row ${rowClass}" data-msg-id="${msg.id}" style="${animStyle}">
              <div class="iris-msg-bubble is-typing">
                <div class="iris-typing-dots">
                  <span></span><span></span><span></span>
                </div>
              </div>
            </div>
          `;
        }

        return `
          <div class="iris-msg-row ${rowClass}" data-msg-id="${msg.id}" style="${animStyle}">
            <div class="iris-msg-bubble">${escapeHtml(msg.text)}</div>
          </div>
        `;
      })
      .join('');

    requestAnimationFrame(() => {
      const rows = Array.from(chatStreamEl.querySelectorAll('.iris-msg-row'));
      const lastTwo = rows.slice(-2);
      let targetStreamHeight = 84;
      if (lastTwo.length > 0) {
        const sumHeight = lastTwo.reduce((acc, el) => acc + el.offsetHeight, 0);
        const gap = lastTwo.length > 1 ? 6 : 0;
        targetStreamHeight = Math.max(84, Math.min(260, sumHeight + gap));
      }
      chatStreamEl.style.height = `${targetStreamHeight}px`;
      chatStreamEl.style.maxHeight = `${targetStreamHeight}px`;

      chatStreamEl.scrollTop = chatStreamEl.scrollHeight;
      btnScrollBottom?.classList.add('is-hidden');
      syncWindowSize();
    });
  }

  function scrollToCurrentMessage(smooth = false) {
    if (!chatStreamEl) return;
    const doScroll = () => {
      chatStreamEl.scrollTo({
        top: chatStreamEl.scrollHeight,
        behavior: smooth ? 'smooth' : 'instant'
      });
      btnScrollBottom?.classList.add('is-hidden');
    };
    doScroll();
    requestAnimationFrame(doScroll);
    setTimeout(doScroll, 50);
    setTimeout(doScroll, 260);
  }

  function unfoldIris() {
    if (barEl.classList.contains('mode-compact')) {
      barEl.classList.remove('mode-compact');
      syncWindowSize();
      scrollToCurrentMessage(false);
    } else {
      scrollToCurrentMessage(true);
    }
    resetInactivityTimer();
  }

  // Show "Actual ↓" button when user scrolls up in the conversation
  chatStreamEl?.addEventListener('scroll', () => {
    if (barEl.classList.contains('mode-compact')) return;
    const distanceFromBottom =
      chatStreamEl.scrollHeight - chatStreamEl.scrollTop - chatStreamEl.clientHeight;
    if (distanceFromBottom > 16) {
      btnScrollBottom?.classList.remove('is-hidden');
    } else {
      btnScrollBottom?.classList.add('is-hidden');
    }
  });

  btnScrollBottom?.addEventListener('click', (e) => {
    e.stopPropagation();
    scrollToCurrentMessage(true);
  });

  function appendOrUpdateUserMessage(text, isStreaming = false) {
    if (messages.length > 0 && messages[messages.length - 1].typing) {
      messages.pop();
    }

    const last = messages[messages.length - 1];
    if (last && last.sender === 'user' && last.streaming) {
      last.text = text;
      last.streaming = isStreaming;
      renderMessages(false);
      if (!isStreaming) persistHistory();
      return;
    }

    messages.push({
      id: nextMsgId++,
      sender: 'user',
      text,
      streaming: isStreaming,
      typing: false
    });

    if (messages.length > 100) messages.shift();
    if (!isStreaming) persistHistory();
    renderMessages(true);
  }

  function showAiTypingDots() {
    const last = messages[messages.length - 1];
    if (last && last.sender === 'ai' && last.typing) {
      return;
    }
    messages.push({
      id: nextMsgId++,
      sender: 'ai',
      text: '...',
      streaming: false,
      typing: true
    });
    renderMessages(true);
  }

  function resolveAiReply(replyText) {
    const last = messages[messages.length - 1];
    if (last && last.sender === 'ai' && last.typing) {
      last.text = replyText;
      last.typing = false;
      persistHistory();
      renderMessages(true);
      return;
    }

    messages.push({
      id: nextMsgId++,
      sender: 'ai',
      text: replyText,
      streaming: false,
      typing: false
    });
    if (messages.length > 100) messages.shift();
    persistHistory();
    renderMessages(true);
  }

  // ==========================================================================
  // SETTINGS INITIALIZATION & HANDLERS
  // ==========================================================================
  let currentSettings = {
    accentColor: localStorage.getItem('iris_accent_color') || '#ff4776',
    doNotDisturb: false,
    autoStart: true,
    primaryModel: 'llama3.2:3b',
    apiKeys: []
  };
  let showApiKeys = false;

  const INACTIVITY_MINIMIZE_MS = 12000;
  let inactivityMinimizeTimer = null;

  function clearInactivityTimer() {
    if (inactivityMinimizeTimer) {
      clearTimeout(inactivityMinimizeTimer);
      inactivityMinimizeTimer = null;
    }
  }

  function resetInactivityTimer(delayMs = INACTIVITY_MINIMIZE_MS) {
    clearInactivityTimer();
    if (barEl.classList.contains('mode-compact')) return;

    inactivityMinimizeTimer = setTimeout(() => {
      if (barEl.classList.contains('mode-compact')) return;
      const isBusy = Boolean(engine?.isListening) || engine?.state !== 'Disponible';
      const isHovered =
        barEl.matches(':hover') ||
        settingsPanelEl.matches(':hover') ||
        inputDrawerEl.matches(':hover') ||
        Boolean(artifactCardEl && artifactCardEl.matches(':hover'));
      const isTyping = document.activeElement === textInputEl && Boolean(textInputEl?.value.trim());

      if (isBusy || isHovered || isTyping) {
        resetInactivityTimer(6000);
        return;
      }

      foldIrisToCompact();
    }, delayMs);
  }

  function foldIrisToCompact() {
    clearInactivityTimer();
    barEl.classList.add('mode-compact');
    inputDrawerEl.classList.add('is-hidden');
    settingsPanelEl.classList.add('is-hidden');
    artifactCardEl?.classList.add('is-hidden');
    btnToggleInput?.classList.remove('active');
    btnToggleSettings?.classList.remove('active');
    syncWindowSize();
  }

  function applyDndMode(enabled) {
    const isEnabled = Boolean(enabled);
    currentSettings.doNotDisturb = isEnabled;
    if (dndToggleEl) dndToggleEl.checked = isEnabled;
    barEl.classList.toggle('mode-dnd', isEnabled);
    window.irisOS?.setDndMode?.(isEnabled);
    syncWindowSize();
  }

  function applyAccentColor(color) {
    document.documentElement.style.setProperty('--iris-reply-bg', color);
    localStorage.setItem('iris_accent_color', color);
    if (customColorInput) customColorInput.value = color;
    colorSwatches.forEach((sw) => {
      sw.classList.toggle('active', sw.getAttribute('data-color')?.toLowerCase() === color.toLowerCase());
    });
  }

  function maskKey(key) {
    if (showApiKeys) return key;
    if (!key || key.length <= 10) return '••••••••••••';
    return `${key.slice(0, 6)}••••••••••••••••${key.slice(-4)}`;
  }

  function renderApiKeysList() {
    if (!apiKeysListEl) return;
    const keys = currentSettings.apiKeys || [];
    if (keys.length === 0) {
      apiKeysListEl.innerHTML = `<div class="iris-api-key-item"><span class="iris-api-key-text" style="color:#8a8783;">Sin API Keys guardadas</span></div>`;
      return;
    }

    apiKeysListEl.innerHTML = keys
      .map(
        (k, idx) => `
        <div class="iris-api-key-item">
          <span class="iris-api-key-text">${escapeHtml(maskKey(k))}</span>
          <button type="button" class="iris-api-remove-btn" data-remove-key-idx="${idx}">Quitar</button>
        </div>
      `
      )
      .join('');

    apiKeysListEl.querySelectorAll('[data-remove-key-idx]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-remove-key-idx'));
        currentSettings.apiKeys.splice(idx, 1);
        if (window.irisOS?.updateSettings) {
          currentSettings = await window.irisOS.updateSettings({ apiKeys: currentSettings.apiKeys });
        }
        renderApiKeysList();
        syncWindowSize();
      });
    });
  }

  async function initSettings() {
    if (window.irisOS?.getSettings) {
      try {
        currentSettings = await window.irisOS.getSettings();
      } catch {
        // fallback
      }
    }
    applyAccentColor(currentSettings.accentColor || '#ff4776');
    applyDndMode(Boolean(currentSettings.doNotDisturb));
    if (autoStartToggleEl) {
      autoStartToggleEl.checked = currentSettings.autoStart !== false;
    }
    renderApiKeysList();

    // Populate Ollama local models
    let models = ['llama3.2:3b', 'llama3.2:1b', 'qwen2.5:3b', 'phi4-mini:latest', 'gemma3:4b'];
    if (window.irisOS?.listOllamaModels) {
      try {
        models = await window.irisOS.listOllamaModels();
      } catch {
        // fallback
      }
    }
    if (modelSelectEl) {
      if (!models.includes(currentSettings.primaryModel)) {
        models.unshift(currentSettings.primaryModel);
      }
      modelSelectEl.innerHTML = models
        .map(
          (m) =>
            `<option value="${escapeHtml(m)}" ${m === currentSettings.primaryModel ? 'selected' : ''}>${escapeHtml(m)}</option>`
        )
        .join('');
    }
  }

  await initSettings();

  // Swatch click handler
  colorSwatches.forEach((sw) => {
    sw.addEventListener('click', async () => {
      const color = sw.getAttribute('data-color');
      if (!color) return;
      currentSettings.accentColor = color;
      applyAccentColor(color);
      if (window.irisOS?.updateSettings) {
        await window.irisOS.updateSettings({ accentColor: color });
      }
    });
  });

  // Custom color input handler
  customColorInput?.addEventListener('input', async (e) => {
    const color = e.target.value;
    currentSettings.accentColor = color;
    applyAccentColor(color);
    if (window.irisOS?.updateSettings) {
      await window.irisOS.updateSettings({ accentColor: color });
    }
  });

  // Local model change handler
  modelSelectEl?.addEventListener('change', async (e) => {
    const newModel = e.target.value;
    currentSettings.primaryModel = newModel;
    if (window.irisOS?.updateSettings) {
      await window.irisOS.updateSettings({ primaryModel: newModel });
    }
  });

  // Modo No Molestar (Mini & Esquivar Ratón)
  dndToggleEl?.addEventListener('change', async (e) => {
    const enabled = Boolean(e.target.checked);
    applyDndMode(enabled);
    if (window.irisOS?.updateSettings) {
      currentSettings = await window.irisOS.updateSettings({ doNotDisturb: enabled });
    }
    if (enabled) {
      setTimeout(() => {
        foldIrisToCompact();
      }, 250);
    }
  });

  // Iniciar al encender el PC
  autoStartToggleEl?.addEventListener('change', async (e) => {
    const enabled = Boolean(e.target.checked);
    currentSettings.autoStart = enabled;
    if (window.irisOS?.setAutoStart) {
      await window.irisOS.setAutoStart(enabled);
    }
  });

  // Show / Hide API Keys toggle
  btnToggleApiVisibility?.addEventListener('click', () => {
    showApiKeys = !showApiKeys;
    btnToggleApiVisibility.textContent = showApiKeys ? 'Ocultar API' : 'Ver API';
    if (newApiInputEl) {
      newApiInputEl.type = showApiKeys ? 'text' : 'password';
    }
    renderApiKeysList();
  });

  // Add new API Key
  const handleAddApiKey = async () => {
    const val = newApiInputEl?.value.trim();
    if (!val) return;
    newApiInputEl.value = '';
    if (!currentSettings.apiKeys.includes(val)) {
      currentSettings.apiKeys.push(val);
      if (window.irisOS?.updateSettings) {
        currentSettings = await window.irisOS.updateSettings({ apiKeys: currentSettings.apiKeys });
      }
    }
    renderApiKeysList();
    syncWindowSize();
  };

  btnAddApiKey?.addEventListener('click', handleAddApiKey);
  newApiInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddApiKey();
  });

  // ==========================================================================
  // CONNECTIONS & INTEGRATIONS HUB (GitHub, Spotify, Notion, Discord, Supabase, Google)
  // ==========================================================================
  const integrationsListEl = document.getElementById('iris-integrations-list');
  const integrationsCountEl = document.getElementById('iris-integrations-count');
  let expandedIntegrationId = null;

  const SERVICE_ICONS = {
    github: `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>`,
    spotify: `<svg width="15" height="15" viewBox="0 0 24 24" fill="#1db954"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.503 17.309c-.215.352-.676.463-1.028.248-2.817-1.722-6.363-2.112-10.54-1.157-.402.092-.801-.16-.893-.562-.092-.403.16-.802.562-.894 4.571-1.045 8.492-.596 11.651 1.337.352.215.463.676.248 1.028zm1.47-3.264c-.27.44-.847.578-1.287.308-3.225-1.982-8.14-2.557-11.954-1.399-.496.151-1.025-.133-1.176-.629-.151-.496.133-1.025.629-1.176 4.364-1.324 9.791-.684 13.48 1.583.44.27.578.847.308 1.313zm.126-3.41c-3.864-2.295-10.237-2.507-13.918-1.39-.592.179-1.22-.164-1.399-.756-.179-.592.164-1.22.756-1.399 4.237-1.286 11.278-1.04 15.707 1.59.533.316.708 1.007.392 1.54-.316.533-1.007.708-1.538.392z"/></svg>`,
    notion: `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.974c-.56-.42-1.307-.887-2.753-.793L2.36 2.067c-.373.047-.466.327-.327.56l2.426 1.581zm.607 4.015v13.627c0 .793.42 1.12 1.213 1.073l14.475-.84c.793-.046.98-.56.98-1.166V6.962c0-.607-.373-.933-.933-.886L5.999 6.962c-.653.047-.933.466-.933 1.261zm13.493.56c.093.42 0 .84-.42.887l-.746.14v10.36c-.466.28-1.073.466-1.586.466-.933 0-1.26-.28-1.96-1.12l-4.993-7.794v7.7c.606.093 1.12.186 1.12.606 0 .42-.327.42-.84.42l-2.8-.046c-.093-.42 0-.84.42-.887l.84-.093V9.67c-.607-.094-.98-.094-1.4-.14-.093-.42 0-.84.42-.887l3.08-.186 5.413 8.353V9.624l-.84-.094c-.093-.42 0-.84.42-.886l3.072-.187c.373 0 .42.14.466.326z"/></svg>`,
    discord: `<svg width="15" height="15" viewBox="0 0 24 24" fill="#5865f2"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`,
    supabase: `<svg width="15" height="15" viewBox="0 0 24 24" fill="#3ecf8e"><path d="M11.9 1.036c-.461-.78-1.595-.572-1.765.325L7.202 16.71c-.13.684.444 1.29 1.139 1.21l10.428-1.2c.877-.101 1.296-1.127.702-1.722L11.9 1.036zM12.1 22.964c.461.78 1.595.572 1.765-.325l2.933-15.349c.13-.684-.444-1.29-1.139-1.21L5.231 7.28c-.877.101-1.296 1.127-.702 1.722L12.1 22.964z"/></svg>`,
    google: `<svg width="15" height="15" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>`,
    obsidian: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a882ff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 19 8.5 16.5 21 7.5 21 5 8.5 12 2"></polygon><polyline points="12 2 12 21"></polyline><polyline points="5 8.5 12 12 19 8.5"></polyline></svg>`
  };

  async function renderIntegrationsList() {
    if (!integrationsListEl || !window.irisOS?.listIntegrations) return;
    let list = [];
    try {
      list = await window.irisOS.listIntegrations();
    } catch {
      return;
    }

    const connectedCount = list.filter((item) => item.connected).length;
    if (integrationsCountEl) {
      integrationsCountEl.textContent = `${connectedCount} activa${connectedCount === 1 ? '' : 's'}`;
    }

    integrationsListEl.innerHTML = list
      .map((item) => {
        const isExp = expandedIntegrationId === item.id;
        const iconSvg = SERVICE_ICONS[item.id] || SERVICE_ICONS.github;
        const statusClass = item.connected ? 'is-connected' : '';
        const statusText = item.connected ? (item.account || 'Conectado') : 'Sin conectar';

        const fieldsHtml = (item.fields || [])
          .map((f) => {
            let extraHint = '';
            if (item.id === 'spotify') {
              extraHint = `<div style="margin-top:5px;"><button type="button" class="iris-small-btn" data-copy-redirect="http://127.0.0.1:8888/callback">Copiar Redirect URI</button></div>`;
            }
            if (item.id === 'google' && f.key === 'clientId') {
              extraHint = `<div style="margin-top:5px;"><button type="button" class="iris-small-btn" data-copy-redirect="http://127.0.0.1:8889/google-callback">Copiar Redirect URI (8889)</button></div>`;
            }
            if (item.id === 'obsidian') {
              const folderPath = item.meta?.nativePath || '';
              if (folderPath) {
                extraHint = `<div style="margin-top:5px;"><button type="button" class="iris-small-btn" data-open-path="${escapeHtml(folderPath)}">Abrir carpeta .md</button></div>`;
              }
            }
            return `
              <div class="iris-integration-field">
                <span class="iris-integration-field-label">${escapeHtml(f.label)}</span>
                <input
                  type="${f.type || 'text'}"
                  class="iris-text-input"
                  data-int-service="${item.id}"
                  data-int-field="${f.key}"
                  placeholder="${escapeHtml(f.placeholder || '')}"
                  value="${escapeHtml(f.value || '')}"
                />
                ${f.hint ? `<span class="iris-integration-field-hint">${escapeHtml(f.hint)}</span>` : ''}
                ${extraHint}
              </div>
            `;
          })
          .join('');

        let actionButtons = '';
        if (item.id === 'obsidian') {
          actionButtons = `<button type="button" class="iris-integration-btn-connect" data-connect-id="obsidian">Guardar ruta</button>`;
          if (item.meta?.isCustomObsidian) {
            actionButtons += `<button type="button" class="iris-integration-btn-disconnect" data-disconnect-id="obsidian" style="margin-left:6px;">Usar nativa</button>`;
          }
        } else {
          actionButtons = item.connected
            ? `<button type="button" class="iris-integration-btn-disconnect" data-disconnect-id="${item.id}">Desconectar</button>`
            : `<button type="button" class="iris-integration-btn-connect" data-connect-id="${item.id}">Conectar</button>`;
        }

        return `
          <div class="iris-integration-card ${item.connected ? 'is-connected' : ''} ${isExp ? 'is-expanded' : ''}" data-service-card="${item.id}">
            <div class="iris-integration-header" data-toggle-card="${item.id}">
              <div class="iris-integration-left">
                <div class="iris-integration-icon-wrap">${iconSvg}</div>
                <div class="iris-integration-titles">
                  <div class="iris-integration-name-row">
                    <span class="iris-integration-name">${escapeHtml(item.name)}</span>
                    ${item.connected && item.account ? `<span class="iris-integration-account">${escapeHtml(item.account)}</span>` : ''}
                  </div>
                  <span class="iris-integration-desc">${escapeHtml(item.description)}</span>
                </div>
              </div>
              <div class="iris-integration-right">
                <span class="iris-integration-status ${statusClass}">${escapeHtml(statusText)}</span>
                <button type="button" class="iris-integration-toggle-btn" title="Configurar">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </button>
              </div>
            </div>
            <div class="iris-integration-body">
              <div class="iris-integration-fields">
                ${fieldsHtml}
              </div>
              <div class="iris-integration-error" id="iris-int-err-${item.id}"></div>
              <div class="iris-integration-actions-row">
                ${actionButtons}
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    // Attach click handlers
    integrationsListEl.querySelectorAll('[data-toggle-card]').forEach((header) => {
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        const serviceId = header.getAttribute('data-toggle-card');
        expandedIntegrationId = expandedIntegrationId === serviceId ? null : serviceId;
        renderIntegrationsList();
        syncWindowSize();
      });
    });

    integrationsListEl.querySelectorAll('[data-copy-redirect]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const url = btn.getAttribute('data-copy-redirect');
        await navigator.clipboard.writeText(url);
        const original = btn.textContent;
        btn.textContent = '¡Copiado!';
        setTimeout(() => (btn.textContent = original), 1400);
      });
    });

    integrationsListEl.querySelectorAll('[data-open-path]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const folderPath = btn.getAttribute('data-open-path');
        if (folderPath && window.irisOS?.executeArtifactAction) {
          await window.irisOS.executeArtifactAction({ url: folderPath });
        }
      });
    });

    integrationsListEl.querySelectorAll('[data-connect-id]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const serviceId = btn.getAttribute('data-connect-id');
        const errEl = document.getElementById(`iris-int-err-${serviceId}`);
        if (errEl) {
          errEl.classList.remove('is-visible');
          errEl.textContent = '';
        }

        const inputs = integrationsListEl.querySelectorAll(`input[data-int-service="${serviceId}"]`);
        const credentials = {};
        inputs.forEach((inp) => {
          const field = inp.getAttribute('data-int-field');
          credentials[field] = inp.value.trim();
        });

        btn.textContent =
          serviceId === 'obsidian'
            ? 'Guardando...'
            : serviceId === 'spotify' || serviceId === 'google'
              ? 'Autoriza en navegador...'
              : 'Conectando...';

        const res = await window.irisOS.connectIntegration(serviceId, credentials);
        if (res?.ok) {
          expandedIntegrationId = null;
          await renderIntegrationsList();
          syncWindowSize();
          if (serviceId === 'github') {
            resolveAiReply(`GitHub conectado como ${res.status.account}. Ya puedes pedirme tus repositorios.`);
          } else if (serviceId === 'spotify') {
            resolveAiReply('Spotify conectado. Ya puedes pedirme canciones o playlists.');
          } else if (serviceId === 'google') {
            resolveAiReply(
              `Google Workspace conectado como ${res.status.accountEmail || 'tu cuenta'}. Ya puedes preguntarme si tienes correos nuevos.`
            );
          } else if (serviceId === 'obsidian') {
            resolveAiReply(`Memoria Markdown configurada (${res.status.account}).`);
          } else {
            resolveAiReply(`${serviceId.toUpperCase()} conectado con éxito.`);
          }
        } else {
          btn.textContent = serviceId === 'obsidian' ? 'Guardar ruta' : 'Conectar';
          if (errEl) {
            errEl.textContent = res?.error || 'Error al conectar el servicio.';
            errEl.classList.add('is-visible');
          }
          syncWindowSize();
        }
      });
    });

    integrationsListEl.querySelectorAll('[data-disconnect-id]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const serviceId = btn.getAttribute('data-disconnect-id');
        await window.irisOS.disconnectIntegration(serviceId);
        await renderIntegrationsList();
        syncWindowSize();
      });
    });
  }

  renderIntegrationsList();
  btnToggleSettings?.addEventListener('click', renderIntegrationsList);

  // ==========================================================================
  // CUSTOM RIGHT-CLICK CONTEXT MENU (Copiar, Pegar, Cortar, Seleccionar todo)
  // ==========================================================================
  let ctxTargetInput = null;
  let ctxTargetBubble = null;

  function hideContextMenu() {
    if (contextMenuEl && !contextMenuEl.classList.contains('is-hidden')) {
      contextMenuEl.classList.add('is-hidden');
      syncWindowSize();
    }
  }

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ctxTargetInput = e.target.closest('input, textarea');
    ctxTargetBubble = e.target.closest('.iris-msg-bubble');

    if (!contextMenuEl) return;
    contextMenuEl.classList.remove('is-hidden');

    const menuWidth = 172;
    const menuHeight = 148;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 6);
    const y = Math.max(4, e.clientY);

    contextMenuEl.style.left = `${Math.max(6, x)}px`;
    contextMenuEl.style.top = `${y}px`;

    // Ensure Electron window is tall enough to show the context menu cleanly
    if (window.irisOS?.resizeWindow && !document.body.classList.contains('showcase-mode')) {
      const currentHeight = document.body.scrollHeight;
      const neededHeight = Math.max(currentHeight, y + menuHeight + 10);
      window.irisOS.resizeWindow(504, neededHeight);
    }
  });

  window.addEventListener('click', (e) => {
    if (!e.target.closest('#iris-context-menu')) {
      hideContextMenu();
    }
  });

  contextMenuEl?.querySelectorAll('[data-ctx-action]').forEach((item) => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.getAttribute('data-ctx-action');

      if (action === 'copy') {
        const selectedText = window.getSelection()?.toString();
        if (selectedText) {
          await navigator.clipboard.writeText(selectedText);
        } else if (ctxTargetInput) {
          const start = ctxTargetInput.selectionStart ?? 0;
          const end = ctxTargetInput.selectionEnd ?? 0;
          const val =
            start !== end
              ? ctxTargetInput.value.slice(start, end)
              : ctxTargetInput.value;
          if (val) await navigator.clipboard.writeText(val);
        } else if (ctxTargetBubble) {
          await navigator.clipboard.writeText(ctxTargetBubble.textContent || '');
        }
      } else if (action === 'paste') {
        try {
          const clipText = await navigator.clipboard.readText();
          if (clipText) {
            const target = ctxTargetInput || textInputEl;
            if (target === textInputEl && inputDrawerEl.classList.contains('is-hidden')) {
              inputDrawerEl.classList.remove('is-hidden');
              btnToggleInput?.classList.add('active');
            }
            if (target) {
              const start = target.selectionStart ?? target.value.length;
              const end = target.selectionEnd ?? target.value.length;
              target.value = target.value.slice(0, start) + clipText + target.value.slice(end);
              target.focus();
            }
          }
        } catch {
          // ignore clipboard permission error
        }
      } else if (action === 'cut') {
        if (ctxTargetInput) {
          const start = ctxTargetInput.selectionStart ?? 0;
          const end = ctxTargetInput.selectionEnd ?? 0;
          if (start !== end) {
            const cutText = ctxTargetInput.value.slice(start, end);
            await navigator.clipboard.writeText(cutText);
            ctxTargetInput.value =
              ctxTargetInput.value.slice(0, start) + ctxTargetInput.value.slice(end);
          } else if (ctxTargetInput.value) {
            await navigator.clipboard.writeText(ctxTargetInput.value);
            ctxTargetInput.value = '';
          }
          ctxTargetInput.focus();
        }
      } else if (action === 'select-all') {
        const target = ctxTargetInput || textInputEl;
        if (target && !target.closest('.is-hidden')) {
          target.focus();
          target.select();
        } else if (ctxTargetBubble) {
          const range = document.createRange();
          range.selectNodeContents(ctxTargetBubble);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }

      hideContextMenu();
    });
  });

  // ==========================================================================
  // INTERACTIVE ARTIFACT RENDERER (Media, Lists, Code, Vision, Integrations)
  // ==========================================================================
  function renderArtifact(artifact) {
    if (!artifactCardEl) return;
    if (!artifact) {
      artifactCardEl.classList.add('is-hidden');
      artifactCardEl.innerHTML = '';
      syncWindowSize();
      return;
    }

    const badge = escapeHtml(artifact.badge || 'Artifact');
    const title = escapeHtml(artifact.title || 'Panel interactivo');
    const subtitle = artifact.subtitle ? `<div class="iris-artifact-sub">${escapeHtml(artifact.subtitle)}</div>` : '';

    let bodyHtml = '';

    // Vision screenshot preview
    if (artifact.imageDataUrl) {
      bodyHtml += `
        <div class="iris-artifact-vision-wrap">
          <img class="iris-artifact-vision-img" src="${artifact.imageDataUrl}" alt="Captura de pantalla" />
        </div>
      `;
    }

    // Code block
    if (artifact.code) {
      bodyHtml += `<pre class="iris-artifact-code">${escapeHtml(artifact.code)}</pre>`;
    }

    // Interactive List items (e.g. recommended Kanye West songs, actions, links)
    if (Array.isArray(artifact.items) && artifact.items.length > 0) {
      bodyHtml += `
        <div class="iris-artifact-items">
          ${artifact.items
            .map((item, idx) => {
              const btnLabel =
                item.actionType === 'play' || item.actionType === 'spotify_play'
                  ? 'Reproducir'
                  : item.actionType === 'copy'
                    ? 'Copiar'
                    : 'Abrir';
              return `
                <div class="iris-artifact-item">
                  <span class="iris-artifact-item-label">${escapeHtml(item.label || item.query || '')}</span>
                  <button type="button" class="iris-artifact-action-btn" data-artifact-item-idx="${idx}">${btnLabel}</button>
                </div>
              `;
            })
            .join('')}
        </div>
      `;
    }

    // Action buttons row (Play/Pause, Next, Open in YouTube/Spotify, Copy Code/Analysis)
    const actions = Array.isArray(artifact.actions) ? [...artifact.actions] : [];
    if (artifact.code && !actions.some((a) => a.copyText)) {
      actions.unshift({ label: 'Copiar código', copyText: artifact.code });
    }

    if (actions.length > 0) {
      bodyHtml += `
        <div class="iris-artifact-actions-row">
          ${actions
            .map(
              (act, idx) => `
              <button type="button" class="iris-artifact-action-btn ${idx > 0 ? 'secondary' : ''}" data-artifact-action-idx="${idx}">
                ${escapeHtml(act.label || 'Ejecutar')}
              </button>
            `
            )
            .join('')}
        </div>
      `;
    }

    artifactCardEl.innerHTML = `
      <div class="iris-artifact-header">
        <div class="iris-artifact-title-wrap">
          <span class="iris-artifact-badge">${badge}</span>
          <span class="iris-artifact-title">${title}</span>
        </div>
        <button type="button" class="iris-artifact-close" id="btn-close-artifact" title="Cerrar panel">✕</button>
      </div>
      ${subtitle}
      ${bodyHtml}
    `;

    artifactCardEl.classList.remove('is-hidden');

    artifactCardEl.querySelector('#btn-close-artifact')?.addEventListener('click', (e) => {
      e.stopPropagation();
      artifactCardEl.classList.add('is-hidden');
      syncWindowSize();
    });

    // Wire item buttons (e.g. clicking "Reproducir" on a recommended song)
    artifactCardEl.querySelectorAll('[data-artifact-item-idx]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-artifact-item-idx'));
        const item = artifact.items?.[idx];
        if (!item) return;

        if (item.copyText) {
          await navigator.clipboard.writeText(item.copyText);
          btn.textContent = 'Copiado';
          setTimeout(() => (btn.textContent = 'Copiar'), 1200);
          return;
        }

        if (item.url) {
          if (window.irisOS?.executeArtifactAction) {
            await window.irisOS.executeArtifactAction({ url: item.url });
          }
          btn.textContent = 'Abierto';
          return;
        }

        if (item.actionType === 'copy') {
          await navigator.clipboard.writeText(item.query || item.label || '');
          btn.textContent = 'Copiado';
          setTimeout(() => (btn.textContent = 'Copiar'), 1200);
          return;
        }

        btn.textContent = 'Abriendo...';
        if (window.irisOS?.executeArtifactAction) {
          const res = await window.irisOS.executeArtifactAction({
            actionType: item.actionType || 'play',
            query: item.query || item.label,
            spotifyItem: item.spotifyItem || null
          });
          if (res?.reply) {
            resolveAiReply(res.reply);
            engine.speakFast(res.reply, 'Disponible');
          }
          if (res?.artifact) {
            renderArtifact(res.artifact);
            setTimeout(pollSpotifyNowPlaying, 650);
            return;
          }
        }
        setTimeout(pollSpotifyNowPlaying, 650);
        btn.textContent = item.actionType === 'play' || item.actionType === 'spotify_play' ? 'Sonando' : 'Abierto';
      });
    });

    // Wire bottom action buttons
    artifactCardEl.querySelectorAll('[data-artifact-action-idx]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-artifact-action-idx'));
        const act = actions[idx];
        if (!act) return;

        if (act.copyText) {
          await navigator.clipboard.writeText(act.copyText);
          const prev = btn.textContent;
          btn.textContent = 'Copiado';
          setTimeout(() => (btn.textContent = prev), 1200);
          return;
        }

        if (window.irisOS?.executeArtifactAction) {
          const res = await window.irisOS.executeArtifactAction(act);
          if (res?.artifact) {
            renderArtifact(res.artifact);
          }
          setTimeout(pollSpotifyNowPlaying, 650);
        }
      });
    });

    requestAnimationFrame(() => syncWindowSize());
  }

  // ==========================================================================
  // AVATAR, ENGINE & DRAWER TOGGLES
  // ==========================================================================
  let spotifyNowPlayingState = {
    isPlaying: false,
    trackName: '',
    artistName: '',
    albumArtUrl: ''
  };
  let lastAvatarRenderKey = 'iris:Disponible';
  avatarSlot.innerHTML = renderIrisAvatarHTML('Disponible', 'live');
  attachIrisEyePhysics(avatarSlot);
  renderMessages(false);

  function syncAvatarAndCompactUI(currentState = engine.state) {
    const isTalkingOrActive = Boolean(engine.isListening) || currentState !== 'Disponible';
    const showSpotifyDisc =
      !isTalkingOrActive &&
      Boolean(spotifyNowPlayingState.isPlaying && (spotifyNowPlayingState.trackName || spotifyNowPlayingState.albumArtUrl));

    if (showSpotifyDisc) {
      const renderKey = `spotify:${spotifyNowPlayingState.albumArtUrl}:${spotifyNowPlayingState.trackName}`;
      if (lastAvatarRenderKey !== renderKey) {
        avatarSlot.innerHTML = renderSpotifyDiscHTML(
          spotifyNowPlayingState.albumArtUrl,
          spotifyNowPlayingState.trackName,
          'live'
        );
        lastAvatarRenderKey = renderKey;
      }
      avatarSlot.classList.remove('is-listening');
      avatarSlot.title = `${spotifyNowPlayingState.trackName} — ${spotifyNowPlayingState.artistName} (Haz clic para hablar con Iris)`;
      const hadSpotifyClass = barEl.classList.contains('has-spotify-now-playing');
      barEl.classList.add('has-spotify-now-playing');
      if (compactTitleEl) compactTitleEl.textContent = spotifyNowPlayingState.trackName || 'Spotify';
      if (compactStatusEl) compactStatusEl.textContent = spotifyNowPlayingState.artistName || 'Sonando en Spotify';
      if (!hadSpotifyClass && barEl.classList.contains('mode-compact')) {
        syncWindowSize();
      }
    } else {
      const renderKey = `iris:${currentState}`;
      if (lastAvatarRenderKey !== renderKey) {
        avatarSlot.innerHTML = renderIrisAvatarHTML(currentState, 'live');
        lastAvatarRenderKey = renderKey;
      }
      avatarSlot.classList.toggle('is-listening', currentState === 'Escuchando');
      avatarSlot.title = 'Haz clic en Iris para hablar (o pulsa Ctrl+Espacio)';
      const hadSpotifyClass = barEl.classList.contains('has-spotify-now-playing');
      barEl.classList.remove('has-spotify-now-playing');
      if (compactTitleEl) compactTitleEl.textContent = 'Iris';
      if (compactStatusEl) {
        compactStatusEl.textContent =
          currentState === 'Escuchando'
            ? 'Escuchando...'
            : currentState === 'Pensando'
              ? 'Pensando...'
              : currentState === 'Respondiendo'
                ? 'Hablando...'
                : 'Ctrl + Espacio';
      }
      if (hadSpotifyClass && barEl.classList.contains('mode-compact')) {
        syncWindowSize();
      }
    }
  }

  let isPollingSpotify = false;
  async function pollSpotifyNowPlaying() {
    if (!window.irisOS?.spotifyNowPlaying || isPollingSpotify) return;
    isPollingSpotify = true;
    try {
      const res = await window.irisOS.spotifyNowPlaying();
      if (res && res.ok && res.isPlaying) {
        spotifyNowPlayingState = {
          isPlaying: true,
          trackName: res.trackName || '',
          artistName: res.artistName || '',
          albumArtUrl: res.albumArtUrl || ''
        };
      } else {
        spotifyNowPlayingState = {
          isPlaying: false,
          trackName: '',
          artistName: '',
          albumArtUrl: ''
        };
      }
      syncAvatarAndCompactUI(engine.state);
    } catch {
      // ignore transient network errors
    } finally {
      isPollingSpotify = false;
    }
  }

  const engine = new IrisReflexEngine({
    onStateChange: (newState) => {
      if (newState === 'Escuchando' || newState === 'Pensando' || newState === 'Respondiendo') {
        clearInactivityTimer();
      } else if (newState === 'Disponible') {
        resetInactivityTimer();
      }
      syncAvatarAndCompactUI(newState);

      if (newState === 'Pensando') {
        showAiTypingDots();
      }

      syncWindowSize();
    },
    onTranscript: (userPromptText, isFinal) => {
      appendOrUpdateUserMessage(userPromptText, !isFinal);
    },
    onReply: (irisReplyText) => {
      resolveAiReply(irisReplyText);
      // Refresh settings in case user pasted a new API key in chat
      if (irisReplyText.includes('API Key detectada')) {
        initSettings();
      }
    },
    onArtifact: (artifact) => {
      renderArtifact(artifact);
    },
    onTurnFinished: () => {
      resetInactivityTimer();
      setTimeout(pollSpotifyNowPlaying, 650);
    }
  });

  pollSpotifyNowPlaying();
  setInterval(pollSpotifyNowPlaying, 3000);

  avatarSlot.addEventListener('click', (e) => {
    e.stopPropagation();
    clearInactivityTimer();
    engine.toggleListening();
  });

  barEl.addEventListener('click', () => {
    unfoldIris();
  });

  btnToggleCompact?.addEventListener('click', (e) => {
    e.stopPropagation();
    const willBeCompact = !barEl.classList.contains('mode-compact');
    if (willBeCompact) {
      foldIrisToCompact();
    } else {
      unfoldIris();
    }
  });

  btnToggleInput?.addEventListener('click', (e) => {
    e.stopPropagation();
    clearInactivityTimer();
    inputDrawerEl.classList.toggle('is-hidden');
    const isOpen = !inputDrawerEl.classList.contains('is-hidden');
    btnToggleInput.classList.toggle('active', isOpen);
    if (isOpen) {
      textInputEl.focus();
    }
    syncWindowSize();
    resetInactivityTimer();
  });

  btnToggleSettings?.addEventListener('click', async (e) => {
    e.stopPropagation();
    clearInactivityTimer();
    settingsPanelEl.classList.toggle('is-hidden');
    const isOpen = !settingsPanelEl.classList.contains('is-hidden');
    btnToggleSettings.classList.toggle('active', isOpen);
    if (isOpen) {
      await initSettings();
    }
    syncWindowSize();
    resetInactivityTimer();
  });

  const submitText = () => {
    const val = textInputEl.value.trim();
    if (!val) return;
    textInputEl.value = '';
    clearInactivityTimer();
    appendOrUpdateUserMessage(val, false);
    engine.processUserTurnAfterPush(val);
  };

  sendBtnEl?.addEventListener('click', submitText);
  textInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitText();
    if (e.key === 'Escape') {
      inputDrawerEl.classList.add('is-hidden');
      btnToggleInput?.classList.remove('active');
      syncWindowSize();
      resetInactivityTimer();
    }
  });

  if (window.irisOS?.onShortcutWake) {
    window.irisOS.onShortcutWake(() => {
      clearInactivityTimer();
      engine.toggleListening();
    });
  }

  if (window.irisOS?.onDndModeSync) {
    window.irisOS.onDndModeSync((enabled) => {
      applyDndMode(enabled);
      if (enabled) {
        foldIrisToCompact();
      }
    });
  }

  if (window.irisOS?.onAutoStartSync) {
    window.irisOS.onAutoStartSync((enabled) => {
      currentSettings.autoStart = Boolean(enabled);
      if (autoStartToggleEl) {
        autoStartToggleEl.checked = currentSettings.autoStart;
      }
    });
  }

  ['mousemove', 'mousedown', 'keydown', 'wheel'].forEach((evtName) => {
    window.addEventListener(
      evtName,
      () => {
        if (!barEl.classList.contains('mode-compact')) {
          resetInactivityTimer();
        }
      },
      { passive: true }
    );
  });

  renderDesignSystemShowcase(engine);
  syncWindowSize();
  resetInactivityTimer();

  function syncWindowSize() {
    if (!window.irisOS?.resizeWindow) return;
    if (document.body.classList.contains('showcase-mode')) {
      window.irisOS.resizeWindow(1140, 820);
      return;
    }
    const isCompact = barEl.classList.contains('mode-compact');
    const inputOpen = !inputDrawerEl.classList.contains('is-hidden');
    const settingsOpen = !settingsPanelEl.classList.contains('is-hidden');
    const artifactOpen = artifactCardEl && !artifactCardEl.classList.contains('is-hidden');

    window.irisOS?.setCompactState?.({
      isCompact,
      hasSpotify: barEl.classList.contains('has-spotify-now-playing')
    });

    if (isCompact) {
      const compactHeight = 80 + (artifactOpen ? (artifactCardEl.offsetHeight || 160) + 8 : 0);
      window.irisOS.resizeWindow(504, compactHeight);
      return;
    }

    const barHeight = Math.max(100, barEl.offsetHeight || 100);
    let totalHeight = barHeight + 6;
    if (artifactOpen) totalHeight += (artifactCardEl.offsetHeight || 160) + 8;
    if (inputOpen) totalHeight += (inputDrawerEl.offsetHeight || 48) + 6;
    if (settingsOpen) {
      const panelHeight = Math.min(290, settingsPanelEl.offsetHeight || 260);
      totalHeight += panelHeight + 8;
    }
    window.irisOS.resizeWindow(504, totalHeight);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderDesignSystemShowcase(engine) {
  const avatarGrid = document.getElementById('ds-avatar-grid');
  if (avatarGrid) {
    const expressions = [
      { state: 'Disponible', desc: 'Figma 7:2 · Ojos atentos base' },
      { state: 'Escuchando', desc: 'Figma 7:6 · Micrófono activo' },
      { state: 'Pensando', desc: 'Figma 7:10 · Inferencia <200ms' },
      { state: 'Respondiendo', desc: 'Figma 7:14 · Síntesis de voz' },
      { state: 'Feliz', desc: 'Nueva · Tarea completada' },
      { state: 'Enfocada', desc: 'Nueva · Modo Pomodoro / Código' },
      { state: 'Sorprendida', desc: 'Nueva · Alerta o visión activa' },
      { state: 'Dormida', desc: 'Nueva · Modo No Molestar' }
    ];

    avatarGrid.innerHTML = expressions
      .map(
        (item) => `
        <div class="ds-avatar-card" data-preview-state="${item.state}">
          ${renderIrisAvatarHTML(item.state, `card-${item.state}`)}
          <div class="ds-avatar-label">${item.state}</div>
          <div class="ds-avatar-sub">${item.desc}</div>
        </div>
      `
      )
      .join('');

    avatarGrid.querySelectorAll('.ds-avatar-card').forEach((card) => {
      card.addEventListener('click', () => {
        const st = card.getAttribute('data-preview-state');
        engine.setState(st);
        avatarGrid.querySelectorAll('.ds-avatar-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
      });
    });
  }

  const tabs = document.querySelectorAll('[data-ds-folder]');
  const sections = document.querySelectorAll('[data-ds-section]');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-ds-folder');
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      sections.forEach((sec) => {
        const secName = sec.getAttribute('data-ds-section');
        sec.style.display = target === 'all' || target === secName ? 'block' : 'none';
      });
    });
  });
}
