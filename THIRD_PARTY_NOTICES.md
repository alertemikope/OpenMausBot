# Third-party notices

OpenMausBot includes or adapts ideas from these MIT-licensed projects:

## OpenClaw / SwabbleKit

Copyright (c) 2026 OpenClaw Foundation.

The local wake-word gate, pause/capture lifecycle, and on-device Apple Speech
design in `electron/resources/speech-helper.swift` were adapted from OpenClaw's
`apps/swabble` and macOS `VoiceWakeRuntime` implementations.

The GPT-Live `/v1/live` multipart wire contract, one-shot WebRTC offer broker,
authenticated sideband lifecycle, bounded early-frame buffering and
`delegation.context.append` channel design in `server/realtime-voice/` were
adapted from OpenClaw's realtime Quicksilver implementation. OpenMausBot owns a
smaller independent implementation and does not embed OpenClaw's framework.

Source: <https://github.com/openclaw/openclaw>

## Talkify

Copyright (c) 2026 Tornike Gomareli.

Talkify's modern Apple `SpeechAnalyzer` pipeline, warm language model handling,
and pure dictation-session state machine informed the native speech roadmap and
failure boundaries documented in `docs/voice-mode.md`.

Source: <https://github.com/tornikegomareli/Talkify>

Both projects are distributed under the MIT License. Their copyright and
permission notices are preserved by this notice and OpenMausBot's MIT license.
