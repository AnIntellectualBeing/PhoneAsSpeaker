package com.syncspeaker.app.core

import kotlin.math.abs

/**
 * Turns noisy "when was this chunk captured?" measurements into a smooth, continuous timeline.
 *
 * Listeners schedule chunk N+1 right after chunk N when their timestamps are contiguous, so we
 * want timestamps that advance by exactly (frames / sampleRate) per chunk. The audio clock and
 * the system clock drift apart slowly (a few ppm), so we gently slew towards the measurements,
 * and re-anchor only on a real discontinuity (e.g. capture paused, buffer overrun).
 *
 * Pure Kotlin, unit-tested in ChunkTimestamperTest.
 */
class ChunkTimestamper(
    private val sampleRate: Int,
    private val reanchorThresholdMs: Double = 40.0,
    private val slewFactor: Double = 0.02,
) {
    private var anchorMs = Double.NaN
    private var anchorFrame = 0L

    /** Number of hard re-anchors so far (useful for diagnostics). */
    var discontinuities = 0
        private set

    /**
     * @param frameIndex index of the first frame of the chunk (frames read since capture start)
     * @param measuredMs best measurement of the host-clock time at which that frame was captured
     * @return the timestamp (host clock, ms) to send with the chunk
     */
    fun timestampFor(frameIndex: Long, measuredMs: Double): Double {
        if (anchorMs.isNaN()) {
            anchorMs = measuredMs
            anchorFrame = frameIndex
            return measuredMs
        }
        val predicted = anchorMs + (frameIndex - anchorFrame) * 1000.0 / sampleRate
        val error = measuredMs - predicted
        if (abs(error) > reanchorThresholdMs) {
            discontinuities++
            anchorMs = measuredMs
            anchorFrame = frameIndex
            return measuredMs
        }
        val correction = error * slewFactor
        anchorMs += correction
        return predicted + correction
    }

    fun reset() {
        anchorMs = Double.NaN
        discontinuities = 0
    }
}
