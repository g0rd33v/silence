# Silence

**An off switch for the world.** Do nothing. Just be.

Silence is a single-purpose app that counts only real silence. Not the time between tapping Start and Stop — the time when the room is quiet, the phone is still, and you aren't touching the screen. Anything else pauses the session.

This is not meditation. It's not wellness. It's a measurable ritual of not-being-interrupted.

## What it does

Pick a mode:

- **Before** · 10m · gather yourself before a meeting, call, or decision
- **After** · 10m · digest after reading, watching, talking
- **Unwind** · 20m · release the pressure of the day
- **Sleep** · 30m · put the phone down before bed *(native only)*
- **Infinity** · ∞ · no target, just space

Tap the dial. Put the phone down. Stop touching it. Be quiet.

The dial counts only while all three conditions hold:

1. Ambient volume is below the silence threshold
2. The device is physically still
3. You aren't touching the screen

Break any of them, the session pauses. Return, it resumes.

## Design principles

**It counts nothing but silence.** Noise, motion, or touch pause the timer. No fake minutes. You see the truth.

**Audio never leaves the device.** The microphone reads a single volume number, locally. Nothing is recorded, transmitted, or stored. Ever.

**The product refuses to entertain you.** No guided audio. No breathing exercises. No coach. No streaks that shame you. The discipline of silence is the feature.

## Status

**v0.1 — web PWA, sprint 01, April 2026.** First runnable version.

Stack: vanilla HTML / CSS / JS. No framework, no backend, no build step. IndexedDB for local history. Service worker for offline and installability.

## Running locally

```bash
# any static server will work; the app has no build step
python3 -m http.server 8000
# then open http://localhost:8000
```

The app requires HTTPS in production for microphone access. `http://localhost` works as an exception.

## Pricing

- **Free** — all modes, last 7 days of history
- **Pro** · $4/mo — full history, analytics, themes *(coming soon)*

## Roadmap

- **Sprint 01** — PWA live at `beta.labs.vc/silence` (this version)
- **Sprint 02** — iOS native (Sleep mode, background sensing, walk-away sessions)
- **Sprint 03** — Android native, Pro tier, themes

## License

Proprietary. All rights reserved.

---

Part of [Labs](https://labs.vc) · bootstrapped · 100% founder-owned
