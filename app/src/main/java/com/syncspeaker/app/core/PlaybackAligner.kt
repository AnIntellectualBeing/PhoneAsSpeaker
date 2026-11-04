package com.syncspeaker.app.core

import kotlin.math.roundToInt

/**
 * Decides how to keep the host phone's own playback ("Play on this phone too") aligned with the
 * listeners. Works on a stream of 16-bit interleaved PCM chunks written to a blocking AudioTrack.
 *
 *  errorMs = (when the next written frame will actually come out of the speaker)
 *          - (when this chunk *should* come out: chunk timestamp + delay)
 *
 *  - error way too negative (early): write silence first.
 *  - error way too positive (late): skip the start of the chunk (or drop it entirely).
 *  - small error: drop or repeat a single frame per chunk (~0.1 % speed change, inaudible).
 *
 * Pure Kotlin, unit-tested in PlaybackAlignerTest.
 */
class PlaybackAligner(
    private val sampleRate: Int,
    private val channels: Int,
    private val hardThresholdMs: Double = 40.0,
    private val deadbandMs: Double = 2.0,
) {
    data class Plan(val silenceFrames: Int, val skipFrames: Int, val slip: Int)

    fun plan(errorMs: Double, chunkFrames: Int): Plan {
        val errFrames = (errorMs * sampleRate / 1000.0).roundToInt()
        return when {
            errorMs < -hardThresholdMs -> Plan(silenceFrames = -errFrames, skipFrames = 0, slip = 0)
            errorMs > hardThresholdMs -> Plan(silenceFrames = 0, skipFrames = minOf(errFrames, chunkFrames), slip = 0)
            errorMs > deadbandMs -> Plan(0, 0, slip = +1)
            errorMs < -deadbandMs -> Plan(0, 0, slip = -1)
            else -> Plan(0, 0, 0)
        }
    }

    /**
     * Applies [plan] to [chunk] (interleaved samples) and returns the samples to write after any
     * silence. slip = +1 drops the last frame, slip = -1 repeats the last frame.
     */
    fun apply(plan: Plan, chunk: ShortArray): ShortArray {
        val frames = chunk.size / channels
        val start = plan.skipFrames.coerceIn(0, frames)
        var body = chunk.copyOfRange(start * channels, chunk.size)
        val bodyFrames = body.size / channels
        if (plan.slip > 0 && bodyFrames > 1) {
            body = body.copyOfRange(0, body.size - channels)
        } else if (plan.slip < 0 && bodyFrames > 0) {
            body = body.copyOf(body.size + channels).also { out ->
                for (c in 0 until channels) out[body.size + c] = body[body.size - channels + c]
            }
        }
        return body
    }
}
