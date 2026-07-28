---
name: selfcanvas
description: Use SelfCanvas through MCP to inspect canvases, edit nodes safely, run generation, combine videos, and prepare artifact downloads.
---

# SelfCanvas

Use the `canvas_*` MCP tools for requests about the user's SelfCanvas project.

1. Start with `canvas_list_canvases`; never guess a canvas or node ID.
2. Call `canvas_get_canvas` and retain its latest `revision`. Use `canvas_search_nodes` when the user describes assets by name or type. To show a found asset in the open browser, call `canvas_apply_operations` with `{ "type": "focus_node", "nodeId": "..." }`.
3. Before a mutation, explain the intended change. Pass the latest revision as `baseRevision` and create one stable `requestId` for that user intent. Reuse it on network retries.
4. Use `canvas_apply_operations` only for additive edits, renames, moves, focus actions and safe field updates. Deletion is intentionally unavailable.
5. Ask for confirmation before `canvas_run_node` or an AI/creative `canvas_create_video_edit`, because these operations may use paid providers.
6. For a direct merge, pass video node IDs in the exact requested order with `mode: "merge"`. For an AI edit use `mode: "ai_edit"`; for AnyCap creative editing use `mode: "creative"` and no more than three sources.
7. Poll long-running work with `canvas_get_job`. After success, call `canvas_list_artifacts`; use `canvas_prepare_download` only with returned artifact IDs.
8. On `revision_conflict`, fetch the canvas again and show the conflict. Do not silently overwrite another browser's changes.
9. Follow `nextCursor` for pagination without decoding or modifying it. Never pass filesystem paths, arbitrary URLs, commands, secrets or API keys to a SelfCanvas tool.
