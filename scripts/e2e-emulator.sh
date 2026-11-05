#!/usr/bin/env bash
# End-to-end test of the Android host app on an emulator (run by CI inside
# reactivecircus/android-emulator-runner, but works with any adb-connected device too).
#
#  1. installs SyncSpeaker + the "beep source" helper app (plays a beep every second as media)
#  2. Capture test screen: checks that the beeps are captured (level meter / logcat)
#  3. starts a party, forwards port 8080 and connects 3 headless-Chromium listeners
#  4. checks that the listeners hear the beeps on a steady 1 s grid and in sync with each other
#  5. saves screenshots, logcat and UI dumps to $OUT for inspection
set -uo pipefail

OUT=${OUT:-e2e-output}
APP=com.syncspeaker.app
SRC=com.syncspeaker.testsource
mkdir -p "$OUT"
FAIL=0

log() { echo "=== $*"; }

# Prints what is on screen (all visible texts) and which activity is in front.
screen() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb shell cat /sdcard/ui.xml > "$OUT/screen.xml" 2>/dev/null
  echo "--- screen ($1): $(adb shell dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity|mResumedActivity' | sed 's/^ *//')"
  python3 - "$OUT/screen.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception as e:
    print('    (no UI dump)'); sys.exit(0)
texts = [n.get('text').strip() for n in root.iter('node') if (n.get('text') or '').strip()]
print('    ' + ' | '.join(t.replace('\n', ' ')[:70] for t in texts[:40]))
PY
}

# Our app's log lines so far (and system lines about media projection / our package).
applog() {
  echo "--- app log ($1):"
  grep -E "SyncSpeaker|PartyService|CaptureEngine|StreamServer|LocalPlayer|MediaProjection|syncspeaker|FATAL|AndroidRuntime: " "$OUT/logcat.txt" \
    | grep -v -E "uiautomator|RuntimeInit|boot image|lock profiling|Shutting down VM|Calling main" | tail -${2:-25} | sed 's/^/    /'
}
shot() { adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null || true; adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb shell cat /sdcard/ui.xml > "$OUT/$1.xml" 2>/dev/null || true; }

# Taps the first on-screen element whose text matches the (case-insensitive) regex, if any.
tap_text() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || return 1
  adb shell cat /sdcard/ui.xml > "$OUT/last-ui.xml" 2>/dev/null || return 1
  local xy
  xy=$(python3 - "$1" "$OUT/last-ui.xml" <<'PY'
import re, sys, xml.etree.ElementTree as ET
pat = re.compile(sys.argv[1], re.I)
try:
    root = ET.parse(sys.argv[2]).getroot()
except Exception:
    sys.exit(0)
for n in root.iter('node'):
    if pat.fullmatch((n.get('text') or '').strip()):
        m = re.findall(r'\d+', n.get('bounds', ''))
        if len(m) == 4:
            x1, y1, x2, y2 = map(int, m)
            print((x1 + x2) // 2, (y1 + y2) // 2)
            break
PY
)
  if [ -n "$xy" ]; then
    log "tapping '$1' at $xy"
    adb shell input tap $xy
    return 0
  fi
  return 1
}

# Accepts the screen-capture consent dialog if Android shows one (normally skipped via appops).
accept_consent() {
  for _ in 1 2 3 4 5; do
    sleep 1
    tap_text 'Entire screen|A single app' >/dev/null 2>&1 && sleep 1
    tap_text 'Start now|Start|Share screen|Next|Allow' && return 0
  done
  return 0
}

log "device: $(adb shell getprop ro.product.model | tr -d '\r'), API $(adb shell getprop ro.build.version.sdk | tr -d '\r')"
adb logcat -c || true
adb logcat -v time > "$OUT/logcat.txt" 2>&1 &
LOGCAT_PID=$!

adb shell svc power stayon true || true
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true
adb shell settings put system screen_off_timeout 1800000 || true
adb shell media volume --stream 3 --set 10 >/dev/null 2>&1 || true

log "installing APKs"
adb install -r -g app/build/outputs/apk/debug/app-debug.apk || FAIL=1
adb install -r -g testsource/build/outputs/apk/debug/testsource-debug.apk || FAIL=1
# Pre-approve screen capture (what tapping "Start now" in the consent dialog does).
adb shell appops set $APP PROJECT_MEDIA allow || true

log "starting the beep source"
adb shell am start -W -n $SRC/.BeepActivity >/dev/null
sleep 2

# ------------------------------------------------------------------ Capture test
log "capture test"
adb shell am start -W -n $APP/.CaptureTestActivity --ez autostart true >/dev/null
sleep 2
screen "after starting the capture test"
accept_consent
sleep 6
screen "capture test running"
applog "capture test"
shot 01-capture-test
if grep -q "capture: " "$OUT/logcat.txt"; then
  grep "capture: " "$OUT/logcat.txt" | tail -3
else
  log "no capture log lines yet"
fi
if grep -q "Sound detected" "$OUT/01-capture-test.xml" 2>/dev/null; then
  log "Capture test shows: Sound detected ✓"
else
  log "Capture test did NOT report sound"
  FAIL=1
fi

# ------------------------------------------------------------------ Party
log "starting the party"
adb shell am start -W -n $APP/.MainActivity --ez autostart true >/dev/null
sleep 2
screen "after Start Party"
accept_consent
sleep 2
screen "party"
applog "party"
adb forward tcp:8080 tcp:8080
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8080/status.json > "$OUT/status.json"; then break; fi
  sleep 1
done
cat "$OUT/status.json" 2>/dev/null && echo || { log "server did not come up"; FAIL=1; }
curl -sf http://127.0.0.1:8080/ | grep -q "Join Party" && log "listener page served ✓" || { log "listener page NOT served"; FAIL=1; }
shot 02-party-started

# The music app is in front, like in real life; SyncSpeaker runs in the background.
adb shell am start -n $SRC/.BeepActivity >/dev/null
sleep 2

log "3 headless listeners for 15 s"
node server/test/browser-test.js --url http://127.0.0.1:8080 --seconds 15 --listeners 3 | tee "$OUT/browser-test.txt"
[ "${PIPESTATUS[0]}" = "0" ] || FAIL=1

adb shell am start -n $APP/.MainActivity >/dev/null
sleep 2
shot 03-party-after-listeners
screen "host app with listeners connected"
curl -sf http://127.0.0.1:8080/status.json && echo

# ------------------------------------------------------------------ "Play on this phone too"
log "enabling 'Play on this phone too'"
tap_text 'Play on this phone too.*' || true
sleep 3
shot 04-play-locally
screen "play on this phone too"
grep -q "LocalPlayer" "$OUT/logcat.txt" && grep "LocalPlayer" "$OUT/logcat.txt" | tail -3

# ------------------------------------------------------------------ Diagnostics
adb shell dumpsys activity services $APP > "$OUT/dumpsys-services.txt" 2>&1 || true
adb shell dumpsys media_projection > "$OUT/dumpsys-media-projection.txt" 2>&1 || true
log "stopping the party"
adb shell am start -n $APP/.MainActivity >/dev/null
sleep 1
tap_text 'Stop Party' || true
sleep 2
shot 05-stopped

kill $LOGCAT_PID 2>/dev/null || true
applog "final" 60
if grep -q "FATAL EXCEPTION" "$OUT/logcat.txt"; then
  log "app crashed:"
  grep -A 25 "FATAL EXCEPTION" "$OUT/logcat.txt" | head -60
  FAIL=1
fi

if [ $FAIL = 0 ]; then log "E2E PASSED"; else log "E2E FAILED"; fi
exit $FAIL
