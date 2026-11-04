package com.syncspeaker.app

import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.TextView
import com.syncspeaker.app.server.Protocol
import java.util.Locale

/**
 * "Can SyncSpeaker capture Spotify?" Starts capture without the server and shows a live level
 * meter, plus an automatic check of whether capture depends on the media volume.
 */
class CaptureTestActivity : ProjectionActivity() {
    private lateinit var testButton: Button
    private lateinit var meter: LevelMeterView
    private lateinit var dbText: TextView
    private lateinit var verdict: TextView
    private lateinit var errorText: TextView
    private lateinit var volumeText: TextView
    private lateinit var volumeResult: TextView
    private lateinit var audio: AudioManager

    private val handler = Handler(Looper.getMainLooper())
    private var soundAtNonZeroVolume = false
    private var zeroVolumeSince = 0.0
    private val observer: (PartyState.Snapshot) -> Unit = { render(it) }

    private val volumePoll = object : Runnable {
        override fun run() {
            updateVolume()
            handler.postDelayed(this, 300)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_capture_test)
        audio = getSystemService(AudioManager::class.java)
        testButton = findViewById(R.id.test_button)
        meter = findViewById(R.id.test_meter)
        dbText = findViewById(R.id.db_text)
        verdict = findViewById(R.id.verdict_text)
        errorText = findViewById(R.id.test_error)
        volumeText = findViewById(R.id.volume_text)
        volumeResult = findViewById(R.id.volume_result)

        testButton.setOnClickListener {
            if (PartyState.snapshot.mode == PartyState.Mode.CAPTURE_TEST) {
                PartyService.stop(this)
            } else {
                soundAtNonZeroVolume = false
                zeroVolumeSince = 0.0
                volumeResult.visibility = View.GONE
                beginCapture(PartyState.Mode.CAPTURE_TEST)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        PartyState.observe(observer)
        handler.post(volumePoll)
    }

    override fun onStop() {
        handler.removeCallbacks(volumePoll)
        PartyState.unobserve(observer)
        super.onStop()
    }

    private fun render(s: PartyState.Snapshot) {
        val testing = s.mode == PartyState.Mode.CAPTURE_TEST
        testButton.setText(if (testing) R.string.stop_test else R.string.start_test)
        testButton.setBackgroundResource(if (testing) R.drawable.button_stop else R.drawable.button_primary)
        errorText.visibility = if (s.error != null) View.VISIBLE else View.GONE
        errorText.text = s.error ?: ""

        if (!testing) {
            meter.setLevel(0f)
            dbText.text = "– dBFS"
            verdict.setText(if (s.mode == PartyState.Mode.PARTY) R.string.status_running else R.string.test_not_running)
            return
        }
        meter.setLevel(s.level.meter)
        dbText.text = String.format(Locale.ROOT, "%.0f dBFS", s.level.db)
        val now = Protocol.hostNowMs()
        val soundNow = now - s.lastSoundMs < 1500
        verdict.setText(
            when {
                soundNow -> R.string.test_sound
                now - s.captureStartedMs > 4000 -> R.string.test_silent
                else -> R.string.test_waiting
            }
        )

        // Automatic volume-dependence check.
        val vol = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
        if (vol > 0 && soundNow) soundAtNonZeroVolume = true
        if (vol == 0) {
            if (zeroVolumeSince == 0.0) zeroVolumeSince = now
            if (soundAtNonZeroVolume && now - zeroVolumeSince > 1500) {
                volumeResult.visibility = View.VISIBLE
                volumeResult.setText(if (soundNow) R.string.volume_independent else R.string.volume_dependent)
            }
        } else {
            zeroVolumeSince = 0.0
        }
    }

    private fun updateVolume() {
        val vol = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        volumeText.text = getString(R.string.media_volume, vol, max)
        render(PartyState.snapshot)
    }
}
