package com.syncspeaker.app.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.os.Process
import android.util.Log
import com.syncspeaker.app.core.PlaybackAligner
import com.syncspeaker.app.server.Protocol
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * "Play on this phone too": plays the captured stream on the host phone with the same delay as
 * the listeners, so the host is in sync with everybody else.
 *
 * Uses AudioTrack.getTimestamp() to know when written frames actually reach the speaker and
 * [PlaybackAligner] to insert silence / skip / slip single frames as needed.
 *
 * Our output is excluded from capture (ALLOW_CAPTURE_BY_NONE + manifest flag), so no echo loop.
 */
class LocalPlayer(
    private val sampleRate: Int,
    private val channels: Int,
    @Volatile var delayMs: Int,
    private val useAlarmStream: Boolean,
) {
    private data class Chunk(val timestampMs: Double, val samples: ShortArray)

    private val queue = ArrayBlockingQueue<Chunk>(400)
    @Volatile private var running = false
    private var thread: Thread? = null

    fun start() {
        if (running) return
        running = true
        thread = Thread({ run() }, "SyncSpeaker-local-player").apply { start() }
    }

    fun stop() {
        running = false
        thread?.interrupt()
        thread?.join(1000)
        thread = null
        queue.clear()
    }

    fun enqueue(timestampMs: Double, samples: ShortArray) {
        if (!running) return
        if (!queue.offer(Chunk(timestampMs, samples))) {
            queue.clear()
            queue.offer(Chunk(timestampMs, samples))
        }
    }

    private fun run() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val attrs = AudioAttributes.Builder()
            .setUsage(if (useAlarmStream) AudioAttributes.USAGE_ALARM else AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE)
            .build()
        val channelMask = if (channels == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(sampleRate)
            .setChannelMask(channelMask)
            .build()
        val minBuf = AudioTrack.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
        val track = try {
            AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(format)
                .setBufferSizeInBytes(maxOf(minBuf * 2, sampleRate / 10 * channels * 2))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (e: Exception) {
            Log.e(TAG, "Cannot create AudioTrack", e)
            running = false
            return
        }

        val aligner = PlaybackAligner(sampleRate, channels)
        val at = AudioTimestamp()
        val silence = ShortArray(sampleRate / 50 * channels) // 20 ms
        var framesWritten = 0L

        fun nextFramePresentationMs(): Double {
            val now = Protocol.hostNowMs()
            val estimate = if (track.getTimestamp(at) && at.framePosition > 0) {
                at.nanoTime / 1_000_000.0 + (framesWritten - at.framePosition) * 1000.0 / sampleRate
            } else {
                now + (framesWritten - track.playbackHeadPosition.toLong()) * 1000.0 / sampleRate
            }
            // After an underrun the timestamp can be stale; audio can never play in the past.
            return maxOf(estimate, now)
        }

        var lastLog = 0.0
        try {
            track.play()
            Log.i(TAG, "Local playback started (${if (useAlarmStream) "alarm" else "media"} volume), delay $delayMs ms")
            while (running) {
                val chunk = queue.poll(200, TimeUnit.MILLISECONDS) ?: continue
                val frames = chunk.samples.size / channels
                val desiredMs = chunk.timestampMs + delayMs
                val errorMs = nextFramePresentationMs() - desiredMs
                val plan = aligner.plan(errorMs, frames)
                val now = Protocol.hostNowMs()
                if (now - lastLog > 5000) {
                    lastLog = now
                    Log.i(TAG, String.format(java.util.Locale.ROOT, "local playback error %.1f ms (plan %s)", errorMs, plan))
                }
                if (plan.skipFrames >= frames) continue // far too late: drop
                var toSilence = minOf(plan.silenceFrames, sampleRate * 5)
                while (toSilence > 0 && running) {
                    val n = minOf(toSilence, silence.size / channels)
                    track.write(silence, 0, n * channels, AudioTrack.WRITE_BLOCKING)
                    framesWritten += n
                    toSilence -= n
                }
                val out = aligner.apply(plan, chunk.samples)
                val written = track.write(out, 0, out.size, AudioTrack.WRITE_BLOCKING)
                if (written > 0) framesWritten += written / channels
            }
        } catch (_: InterruptedException) {
        } catch (e: Exception) {
            Log.e(TAG, "Local playback failed", e)
        } finally {
            try { track.stop() } catch (_: Exception) {}
            track.release()
        }
    }

    companion object {
        private const val TAG = "LocalPlayer"
    }
}
