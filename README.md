# SyncSpeaker

**Turn your friends' phones into one big speaker.**

One phone (the **host**) plays music from any app (Spotify, YouTube Music, a game, …).
Friends scan a QR code, open a web page, tap **Join Party**, and their phones play the same audio,
**in sync with each other**. They don't install anything or log in, and it works offline.

- **Host:** Android app (Android 10+), or any computer with Chrome/Edge (**PC Host mode**, nothing to install).
- **Listeners:** any phone with a modern browser: Chrome on Android, Safari on iPhone, desktop browsers.
- **Local only (v1):** everyone joins the same Wi-Fi or the host's hotspot. No cloud server and no internet needed.

> SyncSpeaker is for private parties. Don't use it to rebroadcast copyrighted music in public.

---

## Contents

- [Get the app (APK)](#get-the-app-apk)
- [Host a party (Android)](#host-a-party-android)
- [Join a party (listeners)](#join-a-party-listeners)
- [First test: can Spotify be captured?](#first-test-can-spotify-be-captured)
- [Avoid hearing the music twice on the host](#avoid-hearing-the-music-twice-on-the-host)
- [PC Host mode (no install)](#pc-host-mode-no-install)
- [How sync works](#how-sync-works)
- [Limitations](#limitations)
- [Build it yourself](#build-it-yourself)
- [Test without a phone (desktop harness)](#test-without-a-phone-desktop-harness)
- [Project layout](#project-layout)
- [Contributing](#contributing) · [License](#license)

---

## Get the app (APK)

**From a Release (easiest):** open the repository's **Releases** page and download
`SyncSpeaker-vX.Y.Z-debug.apk`. A release is created automatically whenever a tag such as `v0.1.0` is pushed.

**From GitHub Actions (every push):**
1. Open the **Actions** tab → workflow **Build** → the latest green run for your branch.
2. Scroll to **Artifacts** and download **SyncSpeaker-debug-apk** (you must be logged in to GitHub).
3. Unzip it; inside is `SyncSpeaker-<commit>-debug.apk`.

**Install on the phone:** copy the APK to the phone (or download it there directly), tap it, and allow
"Install unknown apps" for your browser or file manager when Android asks. Every CI build is signed with the
same committed debug key, so a newer APK installs over an older one.

---

## Host a party (Android)

1. Connect the host phone to Wi-Fi, **or** turn on its **hotspot** so friends can join it directly.
2. Start music in any app (Spotify, YouTube Music, …).
3. Open **SyncSpeaker** → tap **Start Party**.
   - Allow the **audio permission**. Android requires it to capture other apps' audio. SyncSpeaker never uses the microphone.
   - Allow **screen/audio sharing**. On Android 14+ choose **"Entire screen"** if asked; nothing is recorded or sent except audio.
4. The app shows a **QR code** and an address like `http://192.168.1.23:8080` (or tap **Share link** to send it
   through WhatsApp etc.), a level meter that moves when audio is being captured, and the list of connected phones
   with each phone's sync quality (e.g. `iPhone · ±4 ms ✓`). No Wi-Fi around? Tap **Hotspot settings**, turn the
   hotspot on and let friends join it.
5. Switch back to your music app. The party keeps running in the background and while the phone is locked
   (a notification with a **Stop** button stays visible). Tap **Stop Party** when you are done.

Settings on the main screen:

| Setting | What it does |
|---|---|
| **Play on this phone too** | The host phone also plays the synced stream (same delay as everyone), so it is in sync with the group. |
| **Use the alarm volume** | Plays that synced stream on the *alarm* volume channel, so you can set *media* volume to 0. See below. |
| **Delay** (default 1000 ms) | How far behind live everybody plays. A larger value is more robust on busy Wi-Fi. |
| **Keep the screen on** | Recommended: some newer Android versions stop screen sharing when the phone locks. |

## Join a party (listeners)

1. Join the **same Wi-Fi** as the host (or the host's **hotspot**).
2. Scan the QR code with the camera, or type the address shown on the host.
3. Tap **Join Party**. On iPhone this tap is required to unlock audio.
4. Turn the volume up. **iPhone:** turn off Silent mode. Keep the page open. The page tries to keep the screen on
   (Wake Lock API, or a tiny silent looping video where that API is unavailable over plain `http://`).

The page shows **Connecting → Syncing → Playing**, a **sync quality** value (estimated error in ms), a volume slider
and a **sync nudge** slider (−200…+200 ms, remembered on that phone). If one phone sounds slightly early or late
(typical with a Bluetooth speaker), move its nudge until the echo disappears. If Wi-Fi drops, the page reconnects
and re-syncs by itself.

---

## First test: can Spotify be captured?

Apps can forbid audio capture, and Android enforces it. Some streaming apps do this, so try it before the party:

1. SyncSpeaker → **Capture test** → **Start test** (allow the permissions, "Entire screen").
2. Open Spotify (or any app) and play a song.
3. Come back. If the **level meter moves** and it says *"Sound detected ✓"*, that app works.
   If it stays at silence while music plays, that app blocks capture.

The same screen also runs the **media-volume test** described next.

## Avoid hearing the music twice on the host

The music app keeps playing on the host phone immediately, while everybody else hears it ~1 s later.
Android does not let another app mute it. What you can do:

- **Easiest:** turn on **"Play on this phone too"** and turn the original sound down (some apps have their own volume
  slider), or put the host phone away from the group.
- **Best (if your phone supports it):** set the host's **media volume to 0**, then turn on **"Play on this phone too"**
  **and "Use the alarm volume"**, and use the alarm volume as the host's volume.

**Does media volume affect capture? What we found:**
- Playback capture takes the audio inside Android's audio system before it reaches the speaker.
  In stock Android (AOSP), the capture path is a "remote submix" output. When that output serves a capture policy,
  it is treated as fixed, full volume. So turning the media volume down is **expected not to** change what listeners get.
- We could not confirm this on real hardware while building v0.1, and phone makers change the audio stack.
  So the **Capture test measures it on your phone**: play music, slide the media volume to 0, and the app tells you
  either *"capture keeps working at media volume 0 ✓"* (use the "best" setup above) or *"capture went silent"*.
  In the second case, keep media volume up and turn the volume down inside the music app instead (if it has a slider).
- The in-app "Play on this phone too" stream is never captured again: it is excluded from capture three ways
  (manifest flag, `ALLOW_CAPTURE_BY_NONE`, and excluding our own app's UID). So there is no echo loop.
- Using the alarm channel is a workaround: alarm volume is separate from media volume on Android. Alarms also play
  through the speaker when headphones are connected.

Please share your phone model and result in an issue, so this table can grow:

| Phone / Android | Capture at media volume 0 |
|---|---|
| *(your result here)* | |

---

## PC Host mode (no install)

Use a computer as the host: share a browser tab's audio (any OS), or the whole system's audio (Windows/ChromeOS).

```bash
node server/server.js
```

1. On the **same computer**, open **http://localhost:8080/host** in Chrome or Edge.
   It must be `localhost`, because browsers only allow audio sharing on localhost or HTTPS.
2. Click **Share audio** and pick a tab ("Also share tab audio" on), or "Entire screen" with "Also share system audio" (Windows).
3. Friends scan the QR code on that page (same Wi-Fi as the computer) and tap **Join Party**.

Options on the page: **Mute the shared tab on this computer** (Chrome tab sharing only), **Play on this computer too**
(in sync; disabled with "Entire screen" so it can't capture itself), and **Delay**.
The server needs **Node.js 22+** and has **no dependencies**. Allow it through your firewall if phones can't connect.
Server options: `--port 8080 --delay 1000 --host 0.0.0.0`.

---

## How sync works

1. **Timestamps.** The host cuts the audio into **20 ms chunks** and stamps each one with the time it was captured,
   using the host's own steady clock.
2. **Clock sync.** Each listener sends about 10 quick "pings" when it joins, then one every 2 seconds. The host
   answers with its clock time, and the listener works out the difference between the two clocks (like NTP).
   Wi-Fi delays are noisy, so it keeps only the replies with the **shortest round trip**, which are the most accurate.
3. **Everyone plays at the same moment:** chunk time **+ a fixed delay** (default **1000 ms**). The listener converts that
   moment to its own audio clock, including the audio output latency the browser reports, and schedules the chunk there.
   Because every phone aims for the same moment, they are in sync with **each other**. The delay just gives the audio
   time to arrive.
4. **Staying in sync.** Chunks play back to back without gaps. Small drift (clocks run at slightly different speeds)
   is fixed by playing up to 0.5 % faster or slower, which you can't hear. A big jump (more than 15 ms) re-syncs
   immediately with a tiny fade. Chunks that arrive too late are skipped.

In automated tests, listeners land within **about 1 ms** of each other. That covers 3 listeners in headless Chromium,
including runs with 0–60 ms of simulated network jitter. It also covers the full Android chain on Android 10 and 14
emulators: a music-like app is captured, the phone serves the page and streams to 3 listeners, and
"Play on this phone too" stays within a few ms of the listeners. Real phones add their own audio-output latency, which browsers report
imperfectly. Bluetooth adds 100–300 ms. That is what the per-phone **sync nudge** is for.

Details: [PROTOCOL.md](PROTOCOL.md).

---

## Limitations

- **Some apps block audio capture** (Android lets apps opt out). Use the Capture test.
- **The host must be Android 10+** (or a computer with Chrome/Edge). **An iPhone can't host**: iOS has no API to capture other apps' audio.
- **Bluetooth adds delay** (often 100–300 ms) on that phone. Use the sync nudge, or play through the phone speaker.
- **Locking a listener's screen can stop audio**, especially on iPhone. The page tries to keep the screen awake
  (Wake Lock API where available, otherwise a silent looping video), but a manual lock still pauses Safari.
- **Local network only** in v1. The host must be reachable from the listeners. Some public/guest Wi-Fi networks
  isolate devices from each other ("client isolation"); use the host's hotspot instead.
- **Bandwidth:** v1 streams uncompressed audio (~1.5 Mbit/s per listener), which is fine for ~10–20 phones on decent Wi-Fi.
  Opus compression is planned (see `AudioEncoder` / TODO in the code).
- The host phone's own original playback can't be muted by SyncSpeaker (see above).
- **Legal:** for private, local parties only. Don't rebroadcast copyrighted music publicly.

---

## Build it yourself

**Android app** (JDK 17 and the Android SDK; Android Studio works too):

```bash
./gradlew assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest    # JVM tests: server, timestamps, aligner, level meter
```

**Server / web** (Node.js 22+, no `npm install` needed):

```bash
node server/server.js            # PC host mode
node server/test/run-tests.js    # unit + integration tests
```

CI (`.github/workflows/build.yml`) builds and tests everything on every push, including an **end-to-end test on
Android emulators (Android 10 and 14)**: `scripts/e2e-emulator.sh` installs the app plus a tiny "beep source" app
(`testsource/`, plays a beep every second like a music app would), runs the Capture test, starts a party, connects
three headless-Chromium listeners through `adb forward` and checks that they hear the beeps on a steady beat and in
sync. You can run the same script against your own phone over USB (`adb devices` must list it):

```bash
./gradlew assembleDebug && bash scripts/e2e-emulator.sh
```

The script pre-approves screen capture with `adb shell appops set com.syncspeaker.app PROJECT_MEDIA allow`; if your
phone still shows the consent dialog, the script tries to tap "Start now" for you. When a `v*` tag is pushed, it also
publishes the APK as a GitHub Release:

```bash
git tag v0.1.0
```

```bash
git push origin v0.1.0
```

## Test without a phone (desktop harness)

The server can imitate the Android host by generating timestamped test audio itself:

```bash
node server/server.js --beeps              # a beep every second: sync problems sound like a "flam"
```

```bash
node server/server.js --tone 440           # continuous tone
```

```bash
node server/server.js --wav music.wav      # loop a 16-bit PCM WAV
```

```bash
node server/server.js --beeps --jitter 40  # simulate bad Wi-Fi (0-40 ms random delay)
```

Open `http://localhost:8080/` in several browser tabs or windows, or on phones on your Wi-Fi, and tap **Join Party**.
Open **Technical details** on the page to see the clock offset, round trip, dropped chunks and output latency.

**Automated sync test in headless Chromium** (needs Playwright: `npm i -D playwright && npx playwright install chromium`):

```bash
node server/test/browser-test.js                            # server test source, 3 listeners
```

```bash
node server/test/browser-test.js --pc-host                  # audio from the PC host page
```

```bash
node server/test/browser-test.js --pc-host --real-capture   # through real getDisplayMedia (fake device)
```

```bash
node server/test/browser-test.js --jitter 60                # with simulated network jitter
```

Each listener page records, with an AudioWorklet tap, the exact moment each beep is rendered. The test compares those
moments against the true clock offsets (all tabs run on one machine, so the truth is known) and reports the clock-sync
error, the playback error, and the spread between listeners.

---

## Project layout

```
app/                     Android host app (Kotlin, framework Views, no AndroidX)
  src/main/java/com/syncspeaker/app/
    PartyService.kt        foreground service (mediaProjection): capture + server + local playback
    audio/CaptureEngine.kt AudioPlaybackCapture -> 20 ms timestamped PCM chunks
    audio/LocalPlayer.kt   "Play on this phone too" (AudioTrack, timestamp-aligned)
    server/StreamServer.kt NanoHTTPD + NanoWSD: listener page + WebSocket stream
    server/Protocol.kt     wire format, AudioEncoder interface (Opus TODO)
    core/                  pure Kotlin: ChunkTimestamper, PlaybackAligner, LevelMeter
    MainActivity.kt, CaptureTestActivity.kt
testsource/              CI-only helper app: plays a beep every second as media audio
scripts/e2e-emulator.sh  end-to-end test on an emulator or USB-connected phone
web/listener/            listener page (index.html) + shared sync engine (syncspeaker.js)
                         -> packaged into the APK as assets AND served by the Node server
web/pc-host/             PC host page (getDisplayMedia + AudioWorklet), QR encoder
server/                  zero-dependency Node server, WebSocket implementation, test sources, tests
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Especially useful: **Capture test results**
(phone model + whether capture survives media volume 0) and **Opus support**.

## License

[MIT](LICENSE)
