# CanvasPro UI Studio

CanvasPro-style local interactive canvas MVP built with React, Vite, TypeScript, React Flow, Zustand, lucide-react, a local Python bridge, and a BullMQ media worker.

## Frontend Only

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5190/
```

## Full Local AI Stack

Copy `.env.example` to `.env`, then set `SUB2API_API_KEY` if your Sub2API requires a key.

```bash
redis-server
npm run worker
npm run server
npm run dev
```

Runtime endpoints:

- Frontend: `http://127.0.0.1:5190/`
- Local bridge: `http://127.0.0.1:8787/api/health`
- Output files: `http://127.0.0.1:8787/output/...`

## Build

```bash
npm run build
```

## MVP Features

- Dark full-screen canvas workspace
- Floating top bar, left rail, minimap, canvas controls, and quick-create button
- Text, image, video, and asset nodes
- Drag, zoom, connect, select, add nodes, and create new canvases
- Sub2API text/image jobs through an OpenAI-compatible API
- AnyCap CLI video jobs through the local media worker
- Task panel backed by BullMQ job status
- File manager backed by generated files in `output/`
- Local project persistence through `localStorage`
- JSON export button in the left rail

## Provider Routing

- `text` and `image` nodes route to Sub2API.
- `video` and `audio` nodes route to AnyCap.
- Advanced nodes keep local previews until their real providers are wired.
