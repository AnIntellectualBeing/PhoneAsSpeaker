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
        statusText.setText(
            when (s.mode) {
                PartyState.Mode.PARTY -> R.string.status_running
                PartyState.Mode.CAPTURE_TEST -> R.string.status_test_running
                PartyState.Mode.IDLE -> R.string.status_idle
            }
        )
        startButton.setText(if (running) R.string.stop_party else R.string.start_party)
        startButton.setBackgroundResource(if (running) R.drawable.button_stop else R.drawable.button_primary)

        errorText.visibility = if (s.error != null) View.VISIBLE else View.GONE
        errorText.text = s.error ?: ""

        partyInfo.visibility = if (running) View.VISIBLE else View.GONE
        if (running) {
            val url = s.urls.firstOrNull()
            if (url == null) {
                urlText.setText(R.string.no_network)
                qrImage.visibility = View.GONE
                qrUrl = null
            } else {
                urlText.text = url
                qrImage.visibility = View.VISIBLE
                if (url != qrUrl) {
                    val px = (250 * resources.displayMetrics.density).toInt()
                    qrImage.setImageBitmap(QrCode.bitmap(url, px))
                    qrUrl = url
                }
            }
            val others = s.urls.drop(1)
            otherUrls.visibility = if (others.isEmpty()) View.GONE else View.VISIBLE
            otherUrls.text = getString(R.string.other_addresses, others.joinToString("  "))
            listenersText.text = resources.getQuantityString(R.plurals.listener_count, s.listeners, s.listeners)
            levelMeter.setLevel(s.level.meter)
            val now = Protocol.hostNowMs()
            levelHint.setText(
                if (now - s.lastSoundMs < 3000) R.string.capturing_ok else R.string.capturing_silent
            )
        }

        if (running && prefs.keepScreenOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
}
