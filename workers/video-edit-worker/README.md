# SelfCanvas video edit worker

This worker consumes the independent BullMQ queue named by
`VIDEO_EDIT_QUEUE_NAME` (default: `selfcanvas-video-edit`). It never accepts a
remote video URL: referenced media must already be persisted locally.

## Job input

```json
{
  "operation": "ai-edit | concat | creative-edit",
  "prompt": "optional editing instruction",
  "references": [
    { "outputType": "video", "path": "/app/output/input.mp4", "title": "video" }
  ],
  "options": {
    "audioPolicy": "keep | mute | normalize",
    "resolution": "720p | 1080p | 4k",
    "aspectRatio": "16:9",
    "fps": 30,
    "transition": "cut | crossfade",
    "transitionDuration": 0.5,
    "clips": [{ "sourceIndex": 0, "in": 0, "out": 4, "transition": "cut" }],
    "editPlan": { "version": 1, "clips": [], "audio": {}, "output": {} },
    "planOnly": false
  }
}
```

`concat` and `ai-edit` accept 2–20 videos. `creative-edit` accepts 1–3 videos
and invokes AnyCap's `gemini-omni-flash-preview` `edit-video` mode (720p,
16:9 or 9:16, 3–10 seconds). Set `planOnly` on an `ai-edit` job to
preview its validated `VideoEditPlan`, then submit that object as `editPlan` to
render it without running AI analysis again.

## Result

Rendered jobs return `videoUrl`, `fileUrl`, `fileName`, `mimeType`, `size`,
`operation`, the validated `editPlan` (except creative edits), and `warnings`.
No absolute file path is returned.

Input paths are resolved through `realpath` and must be inside the configured
SelfCanvas output directory. Extra trusted media roots can be supplied with
the platform-delimited `VIDEO_EDIT_ALLOWED_ROOTS` environment variable.

## Cancellation

The server-side bridge is `scripts/video-edit-queue.mjs` and supports
`enqueue`, `get`, `list`, `health`, and `cancel`, matching the existing
generation queue CLI shape. To cancel an active render, it sets Redis key
`${VIDEO_EDIT_QUEUE_NAME}:cancel:${jobId}` to any non-empty value (an expiry of
one hour is recommended). The worker polls the key and aborts ffmpeg/ffprobe or
AnyCap. Waiting jobs can be removed normally. The worker also aborts children
after `VIDEO_EDIT_JOB_TIMEOUT_MS` (default two hours). Cancellation and timeout
failures are unrecoverable, so BullMQ will not retry a canceled render even if
`VIDEO_EDIT_JOB_ATTEMPTS` is greater than one.
