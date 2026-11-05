package com.syncspeaker.testsource

import android.app.Activity
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Bundle
import android.os.Process
import android.widget.TextView
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin

/** Plays a 60 ms beep at the start of every second (USAGE_MEDIA, capturable by default). */
class BeepActivity : Activity() {
    @Volatile private var running = false
    private var thread: Thread? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = "Beep source: one beep per second"; textSize = 24f; setPadding(48, 96, 48, 48) })
    }

    override fun onResume() {
        super.onResume()
        if (running) return
        running = true
        thread = Thread({ play() }, "beeps").apply { start() }
    }

    override fun onDestroy() {
        running = false
        thread?.join(500)
        super.onDestroy()
    }

    private fun play() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val rate = 48_000
        val second = ShortArray(rate * 2)
        val beep = (rate * 0.06).toInt()
        for (i in 0 until beep) {
            val v = (0.8 * exp(-i / (rate * 0.02)) * sin(2 * PI * 1000.0 * i / rate) * 32767).toInt().toShort()
            second[2 * i] = v
            second[2 * i + 1] = v
        }
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build()
            )
            .setBufferSizeInBytes(rate / 5 * 4)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track.play()
        while (running) track.write(second, 0, second.size, AudioTrack.WRITE_BLOCKING)
        track.stop()
        track.release()
    }
}
