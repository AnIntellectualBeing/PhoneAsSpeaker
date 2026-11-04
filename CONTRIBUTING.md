# Contributing to SyncSpeaker

Thanks for helping! Bug reports, test results from real phones and pull requests are all welcome.

## Most wanted

- **Capture test results**: phone model, Android version, which apps can be captured (Spotify, YouTube Music, …)
  and whether capture keeps working at media volume 0. Open an issue and we'll add it to the README table.
- **Opus compression** (see `AudioEncoder` in `Protocol.kt` and `decoders` in `syncspeaker.js`).
- Listener behavior on more browsers and devices (especially iPhone with the screen locked, and Bluetooth output).

## Development setup

| Part | Requirements | Commands |
|---|---|---|
| Android app | JDK 17, Android SDK (or Android Studio) | `./gradlew assembleDebug testDebugUnitTest` |
| Server + web | Node.js 22+ (no dependencies) | `node server/server.js --beeps`, `node server/test/run-tests.js` |
| Browser sync tests | Playwright + Chromium | `node server/test/browser-test.js [--pc-host] [--jitter 60]` |

The listener page lives in `web/listener/` and is used by **both** hosts: the APK packages it as assets, and the
Node server serves it. Change it once and test it with the desktop harness (`node server/server.js --beeps`) before
trying it on phones.

## Guidelines

- Keep the listener page **dependency-free and offline**: no CDNs, no build step, one HTML page + `syncspeaker.js`.
  It must work over plain `http://` (no AudioWorklet, WebCodecs or Wake Lock requirements for listeners).
- Keep `app/src/main/java/com/syncspeaker/app/server` and `core` free of Android imports, so they stay testable on the JVM.
- Protocol changes: update `PROTOCOL.md`, both servers and the listener engine together, and keep v1 listeners working.
- Add or update tests for timing logic (`server/test/run-tests.js`, `app/src/test/...`).
- CI must stay green: it builds the APK, runs the JVM tests, the Node tests and the headless-browser sync tests.

## Pull requests

1. Fork the repository and create a branch.
2. Make focused changes with clear commit messages.
3. Run the tests above.
4. Open a PR describing what changed and how you tested it (real devices, if relevant).

By contributing you agree that your contributions are licensed under the MIT License.
