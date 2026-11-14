# I.R.I.S. — Intelligent Realtime Interactive System

Asistente de escritorio HUD de baja latencia (`<200ms` en barra superior) construido con Electron y un servidor de voz local en Python.

## Características principales

- **HUD Top-Bar & Voz en Segundo Plano**: Interfaz compacta flotante en la parte superior que escucha por voz sin necesidad de desplegar el panel de chat, y se despliega al pulsar sobre el texto para chat escrito, historial o configuración.
- **Modo No Molestar (3 posiciones)**: Posicionamiento discreto en `izquierda`, `centro` o `derecha` que esquiva automáticamente el cursor, junto con minimizado automático por inactividad.
- **Orquestador Híbrido de IA y Router de Reflejos**: Enrutamiento rápido para comandos directos y soporte multi-proveedor (Gemini, Groq, Ollama) con ejecución de herramientas del sistema operativo.
- **Integración con Spotify (PKCE OAuth)**: Reproducción, control y carátula giratoria en disco integrada en el avatar cuando suena música (volviendo al avatar de I.R.I.S. al hablar).
- **Integraciones y Memoria**: Soporte para Google (Calendar, Gmail, Tasks), GitHub/Notion/Discord, memoria nativa (`memory-manager`) y sincronización opcional con Obsidian.
- **Inicio Rápido y Arranque con Windows**: Lanzadores `Iniciar_IRIS.bat` e `Iniciar_IRIS_Silencioso.vbs`, más opción de arranque automático al iniciar Windows.

## Estructura del proyecto

```text
I.R.I.S/
├── index.html                   # Vista principal del HUD
├── package.json                 # Dependencias y scripts de Electron
├── Iniciar_IRIS.bat             # Lanzador estándar para Windows
├── Iniciar_IRIS_Silencioso.vbs  # Lanzador en segundo plano sin ventana de consola
├── config/
│   └── ai-config.example.json   # Plantilla de configuración (las claves reales se ignoran en Git)
├── engine_python/
│   ├── voice_server.py          # Motor local de STT/TTS y servidor de voz
│   └── requirements.txt         # Dependencias de Python
└── src/
    ├── assets/figma/            # Estados SVG del avatar de I.R.I.S.
    ├── components/              # Controladores de UI (iris-bar, iris-avatar)
    ├── engine/                  # Motor de reflejos del cliente (reflex-engine)
    ├── main/                    # Proceso principal de Electron, orquestador, herramientas e integraciones
    └── styles/                  # Tokens y estilos HUD (tokens.css, iris.css)
```

## Instalación y puesta en marcha

1. Instalar dependencias de Node.js:
   ```bash
   npm install
   ```
2. Instalar dependencias de Python (`engine_python`):
   ```bash
   pip install -r engine_python/requirements.txt
   ```
3. Copiar `config/ai-config.example.json` a `config/ai-config.json` y configurar tu proveedor/API key (o configurarlo directamente desde el panel de ajustes de I.R.I.S.).
4. Iniciar la aplicación:
   ```bash
   npm start
   ```
   O en Windows, ejecutar `Iniciar_IRIS.bat` / `Iniciar_IRIS_Silencioso.vbs`.
