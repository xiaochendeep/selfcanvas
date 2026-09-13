# AnyCap catalog alignment

`catalog-2026-09-08.json` is a sanitized snapshot of the public AnyCap model and schema endpoints, verified on 2026-09-08. It includes 8 image, 15 video, 1 native audio, and 4 music models. It contains no credentials, generated media, or local paths.

The PC model picker, API validation, and media worker consume the same schema. The capability API refreshes the public catalog and stores successful schemas in `.runtime/anycap-catalog.json`; the bundled snapshot remains available when the network is offline. The response exposes `catalogSource` and `verifiedAt`, so a cached catalog is not presented as a live refresh.

Important schema distinctions:

- `seedance-2.5`: duration enum is 5–30 seconds, resolution 480p/720p/1080p. Its image-to-video mode accepts 9 images and 3 videos. First/last frame mode maps two ordered image references to `first_frame` and `last_frame`.
- `minimax-h3`: duration enum is 5–15 seconds, resolution only `2k`. Although its prose description mentions 4 seconds, the machine-readable enum starts at 5; the application follows the enum. Text-to-video requires a concrete aspect ratio. Multi-modal mode permits adaptive ratio. Only image-to-video declares `generate_audio`; text and multi-modal modes must not send that field.
- `doubao-seed-audio-1-0`: native `audio generate` route, not the historical music-to-audio bridge. Text mode allows at most one speaker ID; audio reference mode needs 1–3 audio files; image reference mode needs one image. The API accepts the corresponding voice, sample-rate, format, and subtitle controls.
- Music models use `music generate`. Their schema duration unit is milliseconds; the PC UI's seconds are multiplied by 1000. `style` is mapped to `tags`, and voice speed/pitch/sample-rate settings are not sent to music models. The canonical Suno revision is `suno-v5.5`; `suno-v5-5` remains a compatibility alias.
- `nano-banana-lite` currently advertises image-to-image mode but that mode's schema does not declare an image input. The application does not invent reference support and rejects references for this mode until an updated schema declares them.

The new worker tests use a temporary fake CLI and verify exact command arguments and reference validation. They do not create paid generation jobs.
