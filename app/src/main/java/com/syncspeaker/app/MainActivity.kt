package com.syncspeaker.app

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import com.syncspeaker.app.server.Protocol

class MainActivity : ProjectionActivity() {
    private lateinit var prefs: Prefs
    private lateinit var statusText: TextView
    private lateinit var startButton: Button
    private lateinit var errorText: TextView
    private lateinit var partyInfo: View
    private lateinit var qrImage: ImageView
    private lateinit var urlText: TextView
    private lateinit var otherUrls: TextView
    private lateinit var listenersText: TextView
    private lateinit var levelMeter: LevelMeterView
    private lateinit var levelHint: TextView
    private lateinit var playLocallySwitch: Switch
    private lateinit var alarmSwitch: Switch
    private lateinit var delayLabel: TextView
    private lateinit var delaySeek: SeekBar
    private lateinit var keepScreenSwitch: Switch

    private var qrUrl: String? = null
    private var lastRunning: Boolean? = null
    private val observer: (PartyState.Snapshot) -> Unit = { render(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        statusText = findViewById(R.id.status_text)
        startButton = findViewById(R.id.start_button)
        errorText = findViewById(R.id.error_text)
        partyInfo = findViewById(R.id.party_info)
        qrImage = findViewById(R.id.qr_image)
        urlText = findViewById(R.id.url_text)
        otherUrls = findViewById(R.id.other_urls)
        listenersText = findViewById(R.id.listeners_text)
        levelMeter = findViewById(R.id.level_meter)
        levelHint = findViewById(R.id.level_hint)
        playLocallySwitch = findViewById(R.id.play_locally_switch)
        alarmSwitch = findViewById(R.id.alarm_switch)
        delayLabel = findViewById(R.id.delay_label)
        delaySeek = findViewById(R.id.delay_seek)
        keepScreenSwitch = findViewById(R.id.keep_screen_switch)

        startButton.setOnClickListener {
            if (PartyState.snapshot.mode == PartyState.Mode.PARTY) {
                PartyService.stop(this)
            } else {
                beginCapture(PartyState.Mode.PARTY)
            }
        }
        findViewById<Button>(R.id.share_button).setOnClickListener {
            val url = PartyState.snapshot.urls.firstOrNull() ?: return@setOnClickListener
            val send = Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, getString(R.string.share_text, url))
            startActivity(Intent.createChooser(send, getString(R.string.share_link)))
        }
        findViewById<Button>(R.id.hotspot_button).setOnClickListener { openHotspotSettings() }
        findViewById<Button>(R.id.capture_test_button).setOnClickListener {
            startActivity(Intent(this, CaptureTestActivity::class.java))
        }

        playLocallySwitch.isChecked = prefs.playLocally
        playLocallySwitch.setOnCheckedChangeListener { _, checked ->
            prefs.playLocally = checked
            PartyService.instance?.setLocalPlayback(checked)
        }
        alarmSwitch.isChecked = prefs.useAlarmStream
        alarmSwitch.setOnCheckedChangeListener { _, checked ->
            prefs.useAlarmStream = checked
            // Restart local playback so the new audio channel takes effect.
            if (prefs.playLocally) PartyService.instance?.setLocalPlayback(true)
        }

        val step = 50
        delaySeek.max = (Prefs.MAX_DELAY_MS - Prefs.MIN_DELAY_MS) / step
        delaySeek.progress = (prefs.delayMs - Prefs.MIN_DELAY_MS) / step
        delayLabel.text = getString(R.string.delay_label, prefs.delayMs)
        delaySeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar, progress: Int, fromUser: Boolean) {
                delayLabel.text = getString(R.string.delay_label, Prefs.MIN_DELAY_MS + progress * step)
            }
            override fun onStartTrackingTouch(seekBar: SeekBar) {}
            override fun onStopTrackingTouch(seekBar: SeekBar) {
                val ms = Prefs.MIN_DELAY_MS + seekBar.progress * step
                prefs.delayMs = ms
                PartyService.instance?.setDelay(ms)
            }
        })

        keepScreenSwitch.isChecked = prefs.keepScreenOn
        keepScreenSwitch.setOnCheckedChangeListener { _, checked ->
            prefs.keepScreenOn = checked
            render(PartyState.snapshot)
        }
        if (savedInstanceState == null) {
            handleSettingsExtras(intent)
            handleAutostart(intent, PartyState.Mode.PARTY)
        }
    }

    /**
     * Automation (CI emulator test, adb):
     *   adb shell am start -n com.syncspeaker.app/.MainActivity --ez play_locally true
     *   adb shell am start -n com.syncspeaker.app/.MainActivity --ez stop_party true
     */
    private fun handleSettingsExtras(i: Intent?) {
        if (i?.hasExtra(EXTRA_PLAY_LOCALLY) == true) {
            playLocallySwitch.isChecked = i.getBooleanExtra(EXTRA_PLAY_LOCALLY, false)
            i.removeExtra(EXTRA_PLAY_LOCALLY)
        }
        if (i?.getBooleanExtra(EXTRA_STOP, false) == true) {
            i.removeExtra(EXTRA_STOP)
            PartyService.stop(this)
        }
    }

    private fun describeListener(l: com.syncspeaker.app.server.StreamServer.ListenerInfo): String {
        val status = when (l.state) {
            "playing" -> if (l.syncMs.isNaN()) "playing" else "±${Math.round(maxOf(1.0, l.syncMs))} ms " + when {
                l.syncMs <= 10 -> "✓"
                l.syncMs <= 25 -> "· good"
                l.syncMs <= 50 -> "· fair"
                else -> "· poor"
            }
            "syncing", "connecting" -> "syncing…"
            "waiting" -> "waiting for audio"
            "suspended" -> "paused (tap needed on that phone)"
            else -> l.state
        }
        return "${l.name} · $status"
    }

    private fun openHotspotSettings() {
        // There is no public intent for the hotspot screen; try the common one, then fall back.
        val candidates = listOf(
            Intent().setClassName("com.android.settings", "com.android.settings.Settings\$TetherSettingsActivity"),
            Intent("android.settings.TETHER_SETTINGS"),
            Intent(android.provider.Settings.ACTION_WIRELESS_SETTINGS),
        )
        for (i in candidates) {
            try {
                startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            } catch (_: Exception) {
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleSettingsExtras(intent)
        handleAutostart(intent, PartyState.Mode.PARTY)
    }

    override fun onStart() {
        super.onStart()
        PartyState.observe(observer)
    }

    override fun onStop() {
        PartyState.unobserve(observer)
        super.onStop()
    }

    private fun render(s: PartyState.Snapshot) {
        val running = s.mode == PartyState.Mode.PARTY
        statusText.setTextIfChanged(
            when (s.mode) {
                PartyState.Mode.PARTY -> R.string.status_running
                PartyState.Mode.CAPTURE_TEST -> R.string.status_test_running
                PartyState.Mode.IDLE -> R.string.status_idle
            }
        )
        startButton.setTextIfChanged(if (running) R.string.stop_party else R.string.start_party)
        if (running != lastRunning) {
            lastRunning = running
            startButton.setBackgroundResource(if (running) R.drawable.button_stop else R.drawable.button_primary)
        }

        errorText.visibility = if (s.error != null) View.VISIBLE else View.GONE
        errorText.setTextIfChanged(s.error ?: "")

        partyInfo.visibility = if (running) View.VISIBLE else View.GONE
        if (running) {
            val url = s.urls.firstOrNull()
            if (url == null) {
                urlText.setTextIfChanged(R.string.no_network)
                qrImage.visibility = View.GONE
                qrUrl = null
            } else {
                urlText.setTextIfChanged(url)
                qrImage.visibility = View.VISIBLE
                if (url != qrUrl) {
                    val px = (250 * resources.displayMetrics.density).toInt()
                    qrImage.setImageBitmap(QrCode.bitmap(url, px))
                    qrUrl = url
                }
            }
            findViewById<View>(R.id.share_button).visibility = if (url == null) View.GONE else View.VISIBLE
            val others = s.urls.drop(1)
            otherUrls.visibility = if (others.isEmpty()) View.GONE else View.VISIBLE
            otherUrls.setTextIfChanged(getString(R.string.other_addresses, others.joinToString("  ")))
            listenersText.setTextIfChanged(resources.getQuantityString(R.plurals.listener_count, s.listeners, s.listeners))
            val detail = findViewById<TextView>(R.id.listeners_detail)
            detail.visibility = if (s.listenerInfo.isEmpty()) View.GONE else View.VISIBLE
            detail.setTextIfChanged(s.listenerInfo.joinToString("\n") { describeListener(it) })
            levelMeter.setLevel(s.level.meter)
            val now = Protocol.hostNowMs()
            levelHint.setTextIfChanged(
                if (now - s.lastSoundMs < 3000) R.string.capturing_ok else R.string.capturing_silent
            )
        }

        if (running && prefs.keepScreenOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    companion object {
        const val EXTRA_PLAY_LOCALLY = "play_locally"
        const val EXTRA_STOP = "stop_party"
    }
}
