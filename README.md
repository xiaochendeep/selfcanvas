# CanvasPro UI Studio

CanvasPro-style local interactive canvas MVP built with React, Vite, TypeScript, React Flow, Zustand, and lucide-react.

## Run

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5190/
```

## Build

```bash
npm run build
```

## MVP Features

- Dark full-screen canvas workspace
- Floating top bar, left rail, minimap, canvas controls, and quick-create button
- Text, image, video, and asset nodes
- Drag, zoom, connect, select, add nodes, and create new canvases
- Mock generation adapter with running progress and offline preview output
- Local project persistence through `localStorage`
- JSON export button in the left rail

## Next Adapter Boundary

The current AI path is intentionally mocked in `src/services/mockGenerationAdapter.ts`.
Replace or wrap that adapter to connect AnyCap, OpenAI-compatible APIs, or a local media backend without rewriting the canvas UI.

