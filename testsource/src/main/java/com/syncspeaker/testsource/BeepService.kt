package com.syncspeaker.testsource

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.IBinder
import android.os.Process
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin

class BeepService : Service() {
    @Volatile private var running = false
    private var thread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("beeps", "Beeps", NotificationManager.IMPORTANCE_LOW))
        val n = Notification.Builder(this, "beeps")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Beep source")
            .setOngoing(true)
            .build()
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        if (!running) {
            running = true
            thread = Thread({ play() }, "beeps").apply { start() }
        }
        return START_STICKY
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
