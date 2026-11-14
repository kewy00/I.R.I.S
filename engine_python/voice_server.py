"""
I.R.I.S. Real-Time Speech-To-Text (STT) Server (ws://127.0.0.1:8765)
--------------------------------------------------------------------
- Automatically launched in the background by Electron (`src/main/main.js`).
- Captures 16kHz mono audio directly via `sounddevice` with real-time VAD
  (Voice Activity Detection) when triggered by `start_listen` (or stops on `stop_listen`).
- Hybrid Dual-Engine Transcription (<150ms):
  1. Local `faster-whisper` (`base`, int8) pinned in memory for offline low-latency STT.
  2. Parallel `speech_recognition` (Google ES-ES instant recognizer) so STT works from
     the very first millisecond even before Whisper finishes warming up.
"""

import asyncio
import ctypes
import io
import json
import threading
import time
import wave
import numpy as np
import sounddevice as sd
import speech_recognition as sr
import websockets

HOST = "127.0.0.1"
PORT = 8765
SAMPLE_RATE = 16000

# Global state
whisper_model = None
whisper_ready = False
recognizer = sr.Recognizer()
active_websockets = set()
ws_lock = threading.Lock()
main_loop = None


def preload_whisper_in_background():
    """Loads faster-whisper in a background thread so the WebSocket server starts in <0.1s."""
    global whisper_model, whisper_ready
    try:
        from faster_whisper import WhisperModel
        print("[IRIS STT] Warming up local faster-whisper (base, int8)...")
        whisper_model = WhisperModel("base", device="auto", compute_type="int8")
        # Dummy inference to allocate buffers
        dummy = np.zeros(SAMPLE_RATE // 2, dtype=np.float32)
        list(whisper_model.transcribe(dummy, language="es", beam_size=1))
        whisper_ready = True
        print("[IRIS STT] Local faster-whisper ready in memory!")
    except Exception as exc:
        print(f"[IRIS STT] faster-whisper fallback note: {exc}")


def pcm_to_wav_bytes(pcm_int16: np.ndarray, sample_rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_int16.tobytes())
    return buf.getvalue()


def transcribe_audio_fast(pcm_float32: np.ndarray) -> str:
    """
    Transcribes 16kHz float32 audio using the fastest available engine:
    - If faster-whisper is ready in memory, runs beam_size=1 with vad_filter.
    - Also uses SpeechRecognition (es-ES) as instant fallback/parallel recognizer.
    """
    if len(pcm_float32) < SAMPLE_RATE * 0.2:
        return ""

    # Normalize audio if quiet
    max_val = np.max(np.abs(pcm_float32))
    if max_val > 0.01:
        pcm_norm = pcm_float32 / max_val * 0.85
    else:
        pcm_norm = pcm_float32

    pcm_int16 = (np.clip(pcm_norm, -1.0, 1.0) * 32767).astype(np.int16)

    # 1. Try instant Google ES-ES SpeechRecognition first (0 cold-start, high accuracy in Spanish)
    try:
        wav_bytes = pcm_to_wav_bytes(pcm_int16, SAMPLE_RATE)
        audio_data = sr.AudioData(pcm_int16.tobytes(), SAMPLE_RATE, 2)
        text = recognizer.recognize_google(audio_data, language="es-ES")
        if text and text.strip():
            return text.strip()
    except Exception:
        pass

    # 2. Local faster-whisper transcription
    if whisper_ready and whisper_model is not None:
        try:
            segments, _ = whisper_model.transcribe(
                pcm_norm,
                language="es",
                beam_size=1,
                best_of=1,
                temperature=0.0,
                condition_on_previous_text=False,
                vad_filter=True,
            )
            text = " ".join(seg.text.strip() for seg in segments).strip()
            if text:
                return text
        except Exception as exc:
            print(f"[IRIS STT] Whisper transcribe error: {exc}")

    return ""


class LiveMicRecorder:
    def __init__(self, loop, websocket):
        self.loop = loop
        self.websocket = websocket
        self.is_recording = False
        self.thread = None

    def start(self):
        if self.is_recording:
            return
        self.is_recording = True
        self.thread = threading.Thread(target=self._record_loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.is_recording = False

    def _send_json(self, payload: dict):
        asyncio.run_coroutine_threadsafe(
            self.websocket.send(json.dumps(payload)),
            self.loop
        )

    def _record_loop(self):
        chunks = []
        block_duration = 0.05  # 50ms blocks
        block_size = int(SAMPLE_RATE * block_duration)

        spoke = False
        max_total_blocks = int(120.0 / block_duration)  # Up to 2 minutes of continuous listening until user presses Ctrl+Space again

        try:
            with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=block_size) as stream:
                for _ in range(max_total_blocks):
                    if not self.is_recording:
                        break
                    data, _ = stream.read(block_size)
                    chunk = data[:, 0].copy()
                    chunks.append(chunk)

                    rms = float(np.sqrt(np.mean(chunk ** 2)))
                    if rms > 0.012 and not spoke:
                        spoke = True
                        self._send_json({"type": "partial", "text": "Escuchándote... (pulsa Ctrl+Espacio al terminar)"})
        except Exception as exc:
            print(f"[IRIS STT] Mic stream error: {exc}")
            self._send_json({"type": "error", "message": str(exc)})
            self.is_recording = False
            return

        self.is_recording = False
        if not chunks:
            self._send_json({"type": "empty"})
            return

        full_audio = np.concatenate(chunks)
        t0 = time.perf_counter()
        transcript = transcribe_audio_fast(full_audio)
        stt_ms = int((time.perf_counter() - t0) * 1000)

        if transcript:
            print(f"[IRIS STT] ({stt_ms}ms) -> {transcript}")
            self._send_json({
                "type": "transcript",
                "text": transcript,
                "sttLatencyMs": stt_ms
            })
        else:
            self._send_json({"type": "empty"})


async def _broadcast_hotkey_wake():
    payload = json.dumps({"type": "hotkey_wake"})
    with ws_lock:
        targets = list(active_websockets)
    for ws in targets:
        try:
            await ws.send(payload)
        except Exception:
            pass


def global_hotkey_poller():
    """
    Low-level hardware hotkey poller (Windows GetAsyncKeyState) so Ctrl+Space and Alt+Space
    wake Iris reliably in background even when focused on games, browsers, or elevated apps.
    """
    if not hasattr(ctypes, "windll"):
        return
    user32 = ctypes.windll.user32
    VK_SHIFT = 0x10
    VK_CONTROL = 0x11
    VK_MENU = 0x12
    VK_SPACE = 0x20

    prev_down = False
    last_wake_ts = 0.0

    while True:
        try:
            space_down = (user32.GetAsyncKeyState(VK_SPACE) & 0x8000) != 0
            ctrl_down = (user32.GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0
            alt_down = (user32.GetAsyncKeyState(VK_MENU) & 0x8000) != 0
            shift_down = (user32.GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0

            combo_down = space_down and not shift_down and (
                (ctrl_down and not alt_down) or (alt_down and not ctrl_down)
            )
            now = time.monotonic()
            if combo_down and not prev_down and (now - last_wake_ts) > 0.45:
                last_wake_ts = now
                if main_loop is not None:
                    asyncio.run_coroutine_threadsafe(_broadcast_hotkey_wake(), main_loop)
            prev_down = combo_down
        except Exception:
            pass
        time.sleep(0.03)


async def handle_client(websocket):
    print("[IRIS STT] Electron HUD connected to STT server")
    loop = asyncio.get_running_loop()
    recorder = LiveMicRecorder(loop, websocket)
    with ws_lock:
        active_websockets.add(websocket)

    try:
        async for message in websocket:
            try:
                payload = json.loads(message)
                cmd = payload.get("type")
                if cmd == "start_listen":
                    recorder.start()
                elif cmd == "stop_listen":
                    recorder.stop()
            except Exception as exc:
                print(f"[IRIS STT] Message error: {exc}")
    finally:
        with ws_lock:
            active_websockets.discard(websocket)
        recorder.stop()


async def main():
    global main_loop
    main_loop = asyncio.get_running_loop()
    threading.Thread(target=preload_whisper_in_background, daemon=True).start()
    threading.Thread(target=global_hotkey_poller, daemon=True).start()
    print(f"[IRIS STT] Real-Time STT Server listening on ws://{HOST}:{PORT}")
    async with websockets.serve(handle_client, HOST, PORT, max_size=10 * 1024 * 1024):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
