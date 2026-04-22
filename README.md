# Silence

**Do nothing. Just be.**

Silence is an app that measures the only metric that matters: how much of your day still belongs to you.

Not to work. Not to the feed. Not to the notification. Not to the optimization. To *you* — the person who exists underneath all of that.

[Open the mini-app in Telegram →](https://t.me/LabsRobot/silence)
[Open the web version →](https://beta.labs.vc/silence/)

## Why this exists

Every app in your life is built to take more of you — more time, more attention, more engagement, more data, more optimization. They have dashboards that show you how productive you were. How much you achieved. How much you *did*.

Silence is the opposite. It tracks how much of your day you spent doing **nothing**. Not performing. Not producing. Not consuming. Just being a person in a quiet room, or on a bench in a park, or on a subway seat, with no agenda and no output.

Everyone deserves this. It's not a luxury, it's not self-care, it's not wellness. It's the baseline condition for being a human being who is still recognizably themselves after a day in the world.

## What it does

You pick how you want to disappear for a while:

- **Before** · 5 min · gather yourself before a meeting, a call, a decision
- **After** · 10 min · digest what just happened before the next thing rushes in
- **Unwind** · 20 min · release the pressure of the day
- **Sleep** · 30 min · put the phone down before bed *(coming soon)*
- **Infinity** · up to 60 min · no target, just space

You tap START. You put the phone down. You stop touching it. You stop moving it. You stop performing for it.

The timer counts. If you tap the screen, pick up the phone, or switch away, it pauses. Come back within three minutes. If you don't, the session ends honestly — what was real gets saved.

## What makes it real

**It counts nothing it can't verify.** The microphone listens for ambient noise. The accelerometer watches for motion. The touch layer notices every tap. The dB number in your session summary is what your environment actually sounded like. You can meditate on a noisy subway — it won't stop you, but it will tell you the truth about where you were.

**It doesn't reward you for performing silence.** If you picked up the phone to check something, that session is marked as interrupted. No streaks to protect. No guilt. Just a log of what actually happened.

**It gets out of the way.** After thirty seconds of verified silence, the entire interface fades. The dial, the buttons, the modes, all of it disappears. What's left is a black screen with a few faint stars. When you move, speak, or touch the phone, it comes back. The app's highest purpose is to stop being an app.

**It never leaves your device.** The microphone reads a single number — volume — locally. Nothing is recorded, transmitted, or stored on a server. Every session log lives in your browser's storage, on your phone, under your control.

## What it isn't

It isn't meditation. It doesn't teach you how to breathe, how to sit, how to empty your mind. It doesn't have a guide, a voice, a curriculum.

It isn't wellness. It doesn't have a streak to protect or a community to impress or a coach to please.

It isn't productivity. The whole point is that the time you spend here produces nothing. That's the feature.

It's a ritual you already know how to do. You've stepped out for a smoke break. You've sat in a car before walking inside. You've looked out a window on a train. Silence gives that its own name, its own timer, and its own honest log.

## Design principles

**One mechanic.** The timer counts only while you're actually silent, still, and not touching the phone. Everything else is in service of that.

**Monochrome.** No color. No gradients that signal motivation. No iconography borrowed from gyms or meditation centers. A black screen, a single dial, the minimum number of words.

**No sound, almost.** A faint shimmer when you start. A gentle bell when a short session ends. Nothing during Sleep. Nothing during Infinity. The product refuses to interrupt you.

**No shame.** If you break silence, the dial says RESUME, not FAILED. If you close the tab, the session saves what was real.

## The log

Every session is recorded: mode, time, duration, average and peak noise level, whether you stayed to the end. The log shows the last ten days as a simple bar chart and a reverse-chronological list.

Over time, the log tells you something honest: how much of your life each day is still yours. If the bars get shorter, you know. If they get longer, you know that too. The data is the whole point.

## Status

**v0.5 — web PWA, April 2026.**

- Modes: Before (5m) · After (10m) · Unwind (20m) · Sleep (30m, locked) · Infinity (up to 60m)
- On-device sensing: microphone + motion + touch + visibility
- Noise level recorded per session (relative dB, not calibrated)
- Steady Night — UI fades to starfield after 30s of verified silence
- IndexedDB log of every session, last 10 days visible on free tier
- Installable as a PWA from mobile browsers
- Telegram mini-app available at [t.me/LabsRobot/silence](https://t.me/LabsRobot/silence)

## Running locally

```bash
# any static server works; the app has no build step
python3 -m http.server 8000
# then open http://localhost:8000
```

The app requires HTTPS in production for microphone access. `http://localhost` works as a development exception.

## Roadmap

- **Native iOS** — unlocks real Sleep mode (background sensing, phone face-down auto-detection), walk-away sessions where the screen can actually go off
- **Native Android** — same, but on Android
- **Pro tier** — full log history beyond 10 days, deeper analytics, themes

## License

Proprietary. All rights reserved.

---

Built by [Eugene Gordeev](https://github.com/g0rd33v) · part of [Labs](https://beta.labs.vc) · bootstrapped · 100% founder-owned
