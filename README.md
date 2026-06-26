# Workbench Vision

A lightweight, fast macOS desktop app that acts as a visual AI assistant. Press a global
hotkey, hold a physical object up to your webcam, capture a single frame, and ask GPT‑4o
questions grounded in what it actually sees.

Built with **Electron + React + TypeScript** (via [electron-vite](https://electron-vite.org)),
using OpenAI's `gpt-4o` vision model.

---

## What it does

1. You're working at your computer. Press **Control + Option + Space** (the global hotkey).
2. A small, always-on-top **webcam overlay** opens, centered on screen.
3. You hold up an object (the primary test case is a **TV remote**).
4. You click **Analyze Object**. The app captures **one** frame, sends it to GPT‑4o, and
   gets back a short "visual context summary" identifying the object and its visible
   features.
5. The overlay closes automatically and the summary (plus a thumbnail of the captured
   frame) appears in the main window's **Visual Context** section.
6. You type natural questions about the object and GPT‑4o answers, grounded in the captured
   image.
7. Press **Control + Option + Space** again any time to toggle the webcam overlay.

### Example (TV remote)

> This appears to be a TV remote. Visible buttons include power, volume, channel, mute, a
> number pad, input/source, and navigation arrows.

---

## Privacy model

Privacy is a core principle of the app:

- The webcam feed is **rendered only locally** in the overlay window. It is never streamed
  anywhere.
- **Nothing is sent to the AI** until you explicitly click **Analyze Object**. At that point
  exactly one still frame is sent.
- All OpenAI calls happen in the **main process**. The renderer (and therefore any web
  content) never sees your API key.
- When the overlay is hidden or closed, the camera stream is fully released
  (`track.stop()` on every track), so the macOS camera indicator light turns **off**.
- Camera-on state ("Camera On" with a pulsing green dot) and the analyzing state
  ("Analyzing object…") are made visually obvious in the UI.

---

## Prerequisites

- **macOS** (the global hotkey, camera permission flow, and overlay behavior are tuned for
  macOS).
- **Node.js 18+** (developed/tested on Node 22).
- An **OpenAI API key** with access to `gpt-4o`.

---

## Setup & run (development)

```bash
# 1. Install dependencies
npm install

# 2. Add your OpenAI API key
cp .env.example .env
# then edit .env and set:
#   OPENAI_API_KEY=sk-...your real key...

# 3. Run in development
npm run dev
```

When the app launches:

- The main window opens.
- Press **Control + Option + Space** to open the webcam overlay (macOS will ask for camera
  permission the first time).
- Hold up an object, click **Analyze Object**, then ask questions in the main window.

> The `.env` file is git-ignored and is loaded by the **main process only**.

---

## Build & package

```bash
# Type-check + bundle main / preload / renderer
npm run build

# Type-check only (no bundle)
npm run typecheck

# Build a distributable macOS app (.dmg + .zip) into ./release
npm run package:mac
```

The packaged macOS build declares `NSCameraUsageDescription` (configured in
`package.json` under `build.mac.extendInfo`) so the system camera-permission prompt shows
an appropriate explanation.

---

## Project structure

```
workbench-vision/
├─ electron.vite.config.ts      # main / preload / renderer (multi-entry) build config
├─ package.json                 # scripts + electron-builder (mac) config
├─ tsconfig.json                # references node + web configs
├─ tsconfig.node.json           # main + preload
├─ tsconfig.web.json            # renderer
├─ .env.example                 # copy to .env and add OPENAI_API_KEY
├─ src/
│  ├─ shared/
│  │  └─ types.ts               # shared IPC types + channel names
│  ├─ main/
│  │  ├─ index.ts               # windows, global hotkey, IPC, camera permission
│  │  └─ openai.ts              # gpt-4o calls: analyzeImage + askQuestion
│  ├─ preload/
│  │  ├─ index.ts               # contextBridge -> window.api
│  │  └─ index.d.ts             # window.api type declaration
│  └─ renderer/
│     ├─ index.html             # MAIN window entry
│     ├─ overlay.html           # WEBCAM OVERLAY window entry
│     └─ src/
│        ├─ main.tsx            # main window React root
│        ├─ overlay.tsx         # overlay React root
│        ├─ App.tsx             # main window UI (context + chat)
│        ├─ Overlay.tsx         # webcam capture UI
│        └─ styles.css          # shared styles
└─ README.md
```

### Two windows, two entry points

This app uses electron-vite's **multi-entry** renderer build:

- `index.html` → `App.tsx` — the normal app window (~900×700, resizable).
- `overlay.html` → `Overlay.tsx` — the frameless, always-on-top webcam overlay
  (~560×560, created hidden and toggled).

---

## How it works (data flow)

```
[Overlay window]                [Main process]                 [Main window]
  getUserMedia preview
  click "Analyze Object"
  capture frame -> JPEG dataURL
  window.api.analyzeImage(dataURL) ── IPC invoke ──► analyze-image
                                                     gpt-4o (image) -> summary
  ◄───────────────── summary ──────────────────────
  window.api.sendVisualContext({summary, imageDataUrl})
                                  ── IPC send ─────► visual-context-updated
                                                     forwards to main window ──► onVisualContext
                                                     auto-hides overlay,           sets context + image
                                                     focuses main window
  (camera released)

  user asks a question
  window.api.askQuestion({context, imageDataUrl, question, history})
                                  ── IPC invoke ──► ask-question
                                                    gpt-4o (image + context + Q) -> answer
  ◄──────────────── answer ──────────────────────  (rendered in chat)
```

- The **renderer keeps the captured image** in state and passes it back with each question,
  so follow-ups stay grounded in the same frame (the simpler, robust approach).
- The **global hotkey** (`Control+Alt+Space`, where macOS Option == Alt) is registered with
  Electron's `globalShortcut` and toggles overlay visibility system-wide, even when the app
  isn't focused. It's unregistered on quit.
- A missing/placeholder `OPENAI_API_KEY` returns a friendly message in the UI rather than
  crashing.

---

## Known limitations (v1)

- macOS-focused. The global hotkey accelerator and camera-permission flow target macOS;
  other platforms aren't a goal for v1.
- Single captured frame per analysis (by design — one still image, not video).
- Conversation history is kept in memory only and resets when the app restarts.
- The captured image and chat live in the renderer's memory; clearing the visual context
  removes the image so subsequent questions are text-only.
- No streaming responses yet — answers appear once fully generated.
- Requires network access and a valid OpenAI key with `gpt-4o` access.
