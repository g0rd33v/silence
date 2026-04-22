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

## Features

### Five modes for five moments

| Mode     | Duration   | When to use it |
|----------|------------|----------------|
| Before   | 5 min      | Gather yourself before a meeting, a call, a decision |
| After    | 10 min     | Digest what just happened before the next thing rushes in |
| Unwind   | 20 min     | Release the pressure of the day |
| Sleep    | 30 min     | Put the phone down before bed *(locked — coming soon)* |
| Infinity | up to 1 h  | No target, just space |

### Verified silence, not performed silence

Silence counts only time it can verify. Three on-device sensors run in parallel, all locally:

- **Microphone** — reads the ambient noise level every frame. Never pauses a session (you can meditate on a subway), but records the average and peak dB so you know where you were.
- **Motion** — the accelerometer watches for the phone being picked up or shaken. If you touch the phone mid-session, it pauses.
- **Touch** — any tap on the screen pauses the session. The dial label turns into **RESUME** — tap it again to continue.
- **Focus** — if the tab is backgrounded (you got a call, switched apps), the session pauses after a 500 ms grace period.

### The 3-minute rule

When a session pauses, a countdown starts. You have three minutes to come back. If you don't, the session ends and saves exactly what was real — no padding, no guilt.

### Steady Night

Ten seconds of verified silence and the entire interface disappears. The dial, the buttons, the modes, everything fades to black. What remains is a field of faint stars. When you move, tap, or speak the environment back to life, the UI returns. The app's highest purpose is to stop being an app.

### Interstellar start, awakening end

- **Start** — a synthesized pipe-organ swell. Three-voice stack (C2 / G2 / C3) with slow attack and a quiet airy shimmer on top. Cinematic, ceremonial — the opposite of a notification sound.
- **End** — a resolved descending bell for Before, After, and Unwind. Sleep ends silently (don't wake the sleeper). Infinity caps at one hour and ends silently too.

### Rate how it felt

After each session, five stars ask **how did it feel?** Each star plays a different sound:

- 1★ — low muffled thud
- 2★ — soft flat tone
- 3★ — neutral mid chime
- 4★ — warm major triad with reverb
- 5★ — bright crystalline glass arpeggio

Your rating is saved with the session. Skip if you don't want to answer.

### The log tells the story

Open the **Your silence** panel from the header:

- **10-day bar chart** showing daily silence totals. Today is highlighted.
- **A wave of stars above the bars** — your daily average rating rounded to an integer. Over time, if the bars get taller and the stars climb, you can literally *see* quality of life improving.
- **Totals row** — 10-day total, session count, longest single session.
- **Session-by-session log** grouped by day. Each row shows mode, time of day, rating stars, duration, and the session's average dB.
- **Interrupted sessions** get a warm dot next to the mode name so you can tell at a glance what was clean and what wasn't.

### Built to be forgotten

- **Monochrome.** Black background, metallic dial, faint stars. Zero color accents. Nothing competing for your attention.
- **No tracking, no analytics.** Every session log lives in your browser's IndexedDB, on your device, under your control.
- **No sign-up.** No account, no email, no profile. You open the page, you tap START, you begin.
- **Installable.** Add to Home Screen on iOS or Android and Silence launches full-screen with no browser chrome.
- **Offline-capable.** A service worker caches the app so you can use it without a connection.

### What it isn't

It isn't meditation. It doesn't teach you how to breathe, how to sit, how to empty your mind.

It isn't wellness. It doesn't have a streak to protect or a community to impress.

It isn't productivity. The whole point is that the time you spend here produces nothing. That's the feature.

It's a ritual you already know how to do. You've stepped out for a smoke break. You've sat in a car before walking inside. You've looked out a window on a train. Silence gives that its own name, its own timer, and its own honest log.

## Design principles

**One mechanic.** The timer counts only while you're actually silent, still, and not touching the phone.

**Monochrome discipline.** No color. No gradients that signal motivation. No iconography borrowed from gyms or meditation centers.

**No sound, almost.** A faint shimmer at START, a gentle bell at the end, five short tones for rating. Nothing during Sleep or Infinity. The product refuses to interrupt you.

**No shame.** If you break silence, the dial says RESUME, not FAILED. If you close the tab, the session saves what was real.

## Running locally

```bash
# any static server works; there's no build step
python3 -m http.server 8000
# then open http://localhost:8000
```

The app requires HTTPS in production for microphone access. `http://localhost` works as a development exception.

## Roadmap

- **Native iOS** — unlocks real Sleep mode (background sensing, phone face-down auto-detection), walk-away sessions where the screen can actually go off
- **Native Android** — same, on the green side
- **Pro tier** — full log history beyond 10 days, deeper analytics, themes

## Status

**v0.7 — web PWA + Telegram mini-app · April 2026.**

## License

Proprietary. All rights reserved.

---

Built by [Eugene Gordeev](https://github.com/g0rd33v) · part of [Labs](https://beta.labs.vc) · bootstrapped · 100% founder-owned
