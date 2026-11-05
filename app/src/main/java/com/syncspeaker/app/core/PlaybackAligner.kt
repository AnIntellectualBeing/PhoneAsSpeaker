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
 *  - small error: drop or repeat 1-4 frames per 20 ms chunk, spread evenly (at most ~0.4 %
 *    speed change, inaudible), which corrects up to ~4 ms per second.
 *
 * Pure Kotlin, unit-tested in PlaybackAlignerTest.
 */
class PlaybackAligner(
    private val sampleRate: Int,
    private val channels: Int,
    private val hardThresholdMs: Double = 25.0,
    private val deadbandMs: Double = 2.0,
    private val maxSlipFrames: Int = 4,
) {
    /** slip > 0: drop that many frames (catch up); slip < 0: repeat that many frames (wait). */
    data class Plan(val silenceFrames: Int, val skipFrames: Int, val slip: Int)

    fun plan(errorMs: Double, chunkFrames: Int): Plan {
        val errFrames = (errorMs * sampleRate / 1000.0).roundToInt()
        return when {
            errorMs < -hardThresholdMs -> Plan(silenceFrames = -errFrames, skipFrames = 0, slip = 0)
            errorMs > hardThresholdMs -> Plan(silenceFrames = 0, skipFrames = minOf(errFrames, chunkFrames), slip = 0)
            errorMs > deadbandMs -> Plan(0, 0, slip = slipFrames(errorMs))
            errorMs < -deadbandMs -> Plan(0, 0, slip = -slipFrames(-errorMs))
            else -> Plan(0, 0, 0)
        }
    }

    /** ~1 frame per 5 ms of error, 1..maxSlipFrames. */
    private fun slipFrames(absErrorMs: Double): Int = (absErrorMs / 5.0).roundToInt().coerceIn(1, maxSlipFrames)

    /**
     * Applies [plan] to [chunk] (interleaved samples) and returns the samples to write after any
     * silence. slip = +1 drops the last frame, slip = -1 repeats the last frame.
     */
    fun apply(plan: Plan, chunk: ShortArray): ShortArray {
        val frames = chunk.size / channels
        val start = plan.skipFrames.coerceIn(0, frames)
        val body = chunk.copyOfRange(start * channels, chunk.size)
        val bodyFrames = body.size / channels
        val n = minOf(kotlin.math.abs(plan.slip), bodyFrames / 2)
        if (n == 0) return body
        // Positions (frame indices) spread evenly over the chunk.
        val marks = BooleanArray(bodyFrames)
        for (k in 0 until n) marks[((k + 0.5) * bodyFrames / n).toInt().coerceAtMost(bodyFrames - 1)] = true
        val outFrames = if (plan.slip > 0) bodyFrames - n else bodyFrames + n
        val out = ShortArray(outFrames * channels)
        var o = 0
        for (f in 0 until bodyFrames) {
            if (plan.slip > 0 && marks[f]) continue // drop this frame
            System.arraycopy(body, f * channels, out, o, channels)
            o += channels
            if (plan.slip < 0 && marks[f]) { // repeat this frame
                System.arraycopy(body, f * channels, out, o, channels)
                o += channels
            }
        }
        return out
    }
}
