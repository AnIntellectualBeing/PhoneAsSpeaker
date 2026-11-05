package com.syncspeaker.app.audio

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.projection.MediaProjection
import android.os.Process
import android.util.Log
import com.syncspeaker.app.core.ChunkTimestamper
import com.syncspeaker.app.core.Level
import com.syncspeaker.app.server.Protocol
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs

/**
 * Captures what other apps are playing (AudioPlaybackCapture, Android 10+) as 48 kHz / 16-bit /
 * stereo PCM, cuts it into [CHUNK_MS] chunks and timestamps every chunk with the host's
 * monotonic clock (the moment its first sample was captured).
 */
class CaptureEngine(
    private val projection: MediaProjection,
    private val onChunk: (timestampMs: Double, pcmBytes: ByteArray, samples: ShortArray) -> Unit,
    private val onLevel: (Level) -> Unit,
    private val onError: (String) -> Unit,
) {
    @Volatile private var running = false
    private var thread: Thread? = null

    fun start() {
        if (running) return
        running = true
        thread = Thread({ run() }, "SyncSpeaker-capture").apply { start() }
    }

    fun stop() {
        running = false
        thread?.interrupt()
        thread?.join(1000)
        thread = null
    }

    private fun buildConfig(excludeSelf: Boolean): AudioPlaybackCaptureConfiguration {
        val b = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
        if (excludeSelf) b.excludeUid(Process.myUid())
        return b.build()
    }

    @SuppressLint("MissingPermission") // RECORD_AUDIO is requested before the service starts.
    private fun createRecord(): AudioRecord {
        val config = try {
            buildConfig(excludeSelf = true)
        } catch (e: Exception) {
            // Our own output is also protected by allowAudioPlaybackCapture=false, so this is fine.
            buildConfig(excludeSelf = false)
        }
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
            .build()
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
        val bufferBytes = maxOf(minBuf * 4, CHUNK_FRAMES * CHANNELS * 2 * 8)
        return AudioRecord.Builder()
            .setAudioFormat(format)
            .setBufferSizeInBytes(bufferBytes)
            .setAudioPlaybackCaptureConfig(config)
            .build()
    }

    private fun run() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val record = try {
            createRecord().also {
                if (it.state != AudioRecord.STATE_INITIALIZED) {
                    it.release()
                    throw IllegalStateException("AudioRecord could not be initialized")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Cannot start capture", e)
            onError("Cannot start audio capture: ${e.message}")
            running = false
            return
        }

        val samples = ShortArray(CHUNK_FRAMES * CHANNELS)
        val timestamper = ChunkTimestamper(SAMPLE_RATE)
        val at = AudioTimestamp()
        var framesRead = 0L
        var lastLevelMs = 0.0
        var lastLogMs = 0.0
        var meterPeak = Level.SILENT
        var logPeak = Level.SILENT
        var usedHwTimestamp = false

        try {
            record.startRecording()
            Log.i(TAG, "Capture started")
            while (running) {
                // Fill one whole chunk.
                var filled = 0
                while (filled < samples.size && running) {
                    val n = record.read(samples, filled, samples.size - filled, AudioRecord.READ_BLOCKING)
                    if (n < 0) throw IllegalStateException("AudioRecord.read error $n")
                    filled += n
                }
                if (!running) break
                val now = Protocol.hostNowMs()
                val frameIndex = framesRead
                framesRead += CHUNK_FRAMES

                // When was the first frame of this chunk captured?
                var measured = now - CHUNK_MS
                if (record.getTimestamp(at, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS) {
                    val fromTs = at.nanoTime / 1_000_000.0 + (frameIndex - at.framePosition) * 1000.0 / SAMPLE_RATE
                    // Sanity check: must lie within the last two seconds.
                    if (fromTs <= now && abs(now - fromTs) < 2000) {
                        measured = fromTs
                        usedHwTimestamp = true
                    }
                }
                val timestampMs = timestamper.timestampFor(frameIndex, measured)

                val bytes = ByteArray(samples.size * 2)
                ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(samples)
                onChunk(timestampMs, bytes, samples.copyOf())

                // Report the LOUDEST chunk since the last report, so short sounds are never missed.
                val level = Level.of(samples)
                if (level.db > meterPeak.db) meterPeak = level
                if (level.db > logPeak.db) logPeak = level
                if (now - lastLevelMs >= 50) {
                    lastLevelMs = now
                    onLevel(meterPeak)
                    meterPeak = Level.SILENT
                }
                if (now - lastLogMs >= 5000) {
                    lastLogMs = now
                    Log.i(TAG, String.format(java.util.Locale.ROOT,
                        "capture: loudest %.1f dBFS in the last 5 s, %d s captured, hw timestamps=%b, re-anchors=%d, ts-now=%.1f ms",
                        logPeak.db, framesRead / SAMPLE_RATE, usedHwTimestamp, timestamper.discontinuities, timestampMs - now))
                    logPeak = Level.SILENT
                }
            }
        } catch (e: Exception) {
            if (running) {
                Log.e(TAG, "Capture failed", e)
                onError("Audio capture stopped: ${e.message}")
            }
        } finally {
            try { record.stop() } catch (_: Exception) {}
            record.release()
            Log.i(TAG, "Capture stopped (re-anchors: ${timestamper.discontinuities})")
        }
    }

    companion object {
        private const val TAG = "CaptureEngine"
        const val SAMPLE_RATE = 48_000
        const val CHANNELS = 2
        const val CHUNK_MS = 20.0
        const val CHUNK_FRAMES = 960 // 20 ms at 48 kHz
    }
}
