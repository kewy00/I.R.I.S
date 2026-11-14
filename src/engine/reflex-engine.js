/**
 * I.R.I.S. <200ms Fast Reflex Voice & Hybrid AI Engine
 * - Real-Time Speech-To-Text (STT) via Python WebSocket (`ws://127.0.0.1:8765`)
 *   using `sounddevice` + `SpeechRecognition (es-ES)` + `faster-whisper (int8)`.
 * - Connects to Electron Main Process `IrisAIOrchestrator`:
 *   1. Local `llama3.2:3b` via Ollama (in background VRAM) for instant replies
 *   2. Dual Google Gemini Pools (Vision AI + Thinking Text AI) with automatic token rotation
 */

export class IrisReflexEngine {
  constructor(callbacks = {}) {
    this.onStateChange = callbacks.onStateChange || (() => {});
    this.onTranscript = callbacks.onTranscript || (() => {});
    this.onReply = callbacks.onReply || (() => {});
    this.onArtifact = callbacks.onArtifact || (() => {});
    this.onLatency = callbacks.onLatency || (() => {});
    this.onTimerUpdate = callbacks.onTimerUpdate || (() => {});
    this.onTurnFinished = callbacks.onTurnFinished || (() => {});

    this.state = 'Disponible';
    this.isListening = false;
    this.preferredVoice = null;
    this.wsStt = null;
    this.currentSpeechId = 0;

    this.initTTS();
    this.connectPythonSTT();
    this.listenForBackgroundGemini();
  }

  initTTS() {
    if (!('speechSynthesis' in window)) return;
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      this.preferredVoice =
        voices.find(
          (v) =>
            v.lang.startsWith('es') &&
            (v.name.includes('Natural') ||
              v.name.includes('Elvira') ||
              v.name.includes('Sabina') ||
              v.name.includes('Helena'))
        ) ||
        voices.find((v) => v.lang.startsWith('es')) ||
        voices[0];
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }

  listenForBackgroundGemini() {
    if (!window.irisOS?.onBackgroundReply) return;
    window.irisOS.onBackgroundReply((bgData) => {
      if (!bgData?.reply) return;
      this.setState(bgData.expression || 'Respondiendo');
      this.onReply(bgData.reply, bgData.expression || 'Respondiendo');
      this.speakFast(bgData.reply, bgData.postExpression || 'Disponible');
    });
  }

  connectPythonSTT() {
    try {
      const ws = new WebSocket('ws://127.0.0.1:8765');
      ws.onopen = () => {
        this.wsStt = ws;
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'hotkey_wake') {
            window.irisOS?.triggerHotkeyWake?.();
            return;
          }
          if (data.type === 'partial' && data.text) {
            this.onTranscript(data.text, false);
          } else if (data.type === 'transcript' && data.text) {
            this.isListening = false;
            this.onTranscript(data.text, true);
            this.processUserTurnAfterPush(data.text);
          } else if (data.type === 'empty' || data.type === 'error') {
            this.isListening = false;
            this.onTranscript('No te he escuchado bien', true);
            this.setState('Disponible');
            this.onTurnFinished();
          }
        } catch (err) {
          console.warn(err);
        }
      };
      ws.onclose = () => {
        this.wsStt = null;
        // Auto-reconnect after 1.5s
        setTimeout(() => this.connectPythonSTT(), 1500);
      };
      ws.onerror = () => {
        // Handled by onclose
      };
    } catch {
      setTimeout(() => this.connectPythonSTT(), 1500);
    }
  }

  setState(newState) {
    this.state = newState;
    this.onStateChange(newState);
  }

  async toggleListening() {
    // If already listening, pressing Ctrl+Space / Alt+Space or clicking Iris finishes recording and triggers transcription
    if (this.isListening) {
      this.isListening = false;
      this.onTranscript('Transcribiendo...', false);
      if (this.wsStt && this.wsStt.readyState === WebSocket.OPEN) {
        this.wsStt.send(JSON.stringify({ type: 'stop_listen' }));
      } else {
        this.setState('Disponible');
      }
      return;
    }

    // Barge-in: cancel ongoing speech in <10ms
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    this.isListening = true;
    this.setState('Escuchando');
    this.onTranscript('Escuchando...', false);

    if (this.wsStt && this.wsStt.readyState === WebSocket.OPEN) {
      this.wsStt.send(JSON.stringify({ type: 'start_listen' }));
    } else {
      // Reconnect and send start_listen once connected
      this.connectPythonSTT();
      setTimeout(() => {
        if (this.wsStt && this.wsStt.readyState === WebSocket.OPEN) {
          this.wsStt.send(JSON.stringify({ type: 'start_listen' }));
        }
      }, 400);
    }
  }

  async processUserTurn(userText) {
    this.isListening = false;
    this.onTranscript(userText, true);
    await this.processUserTurnAfterPush(userText);
  }

  async processUserTurnAfterPush(userText) {
    this.isListening = false;
    const t0 = performance.now();
    this.setState('Pensando');

    let result;
    if (window.irisOS?.askAI) {
      result = await window.irisOS.askAI(userText);
    } else {
      await new Promise((r) => setTimeout(r, 350));
      result = {
        reply: 'Hola, estoy lista para ayudarte',
        expression: 'Respondiendo',
        postExpression: 'Disponible'
      };
    }

    const t1 = performance.now();
    this.onLatency(result.latencyMs || Math.round(t1 - t0));

    this.setState(result.expression || 'Respondiendo');
    this.onReply(result.reply, result.expression || 'Respondiendo');
    if (result.artifact) {
      this.onArtifact(result.artifact);
    }
    this.speakFast(result.reply, result.postExpression || 'Disponible');
  }

  speakFast(text, afterExpression = 'Disponible') {
    const safeAfter = afterExpression === 'Pensando' ? 'Disponible' : afterExpression;
    if (!('speechSynthesis' in window)) {
      setTimeout(() => {
        this.setState(safeAfter);
        this.onTurnFinished();
      }, 1200);
      return;
    }

    const mySpeechId = ++this.currentSpeechId;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    if (this.preferredVoice) utter.voice = this.preferredVoice;
    utter.lang = 'es-ES';
    utter.rate = 1.12;
    utter.pitch = 1.05;

    utter.onend = () => {
      if (mySpeechId === this.currentSpeechId) {
        this.setState(safeAfter);
        this.onTurnFinished();
      }
    };
    utter.onerror = () => {
      if (mySpeechId === this.currentSpeechId) {
        this.setState(safeAfter);
        this.onTurnFinished();
      }
    };

    window.speechSynthesis.speak(utter);
  }
}
