package com.syncspeaker.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class CoreTest {
    @Test
    fun timestampsAreContinuousDespiteJitter() {
        val ts = ChunkTimestamper(48_000)
        val frames = 960 // 20 ms
        var prev = Double.NaN
        val rnd = java.util.Random(1)
        for (i in 0 until 500) {
            val truth = 1000.0 + i * 20.0
            val measured = truth + (rnd.nextDouble() - 0.5) * 6.0 // +-3 ms jitter
            val t = ts.timestampFor(i.toLong() * frames, measured)
            if (!prev.isNaN()) assertEquals(20.0, t - prev, 0.1)
            assertEquals(truth, t, 4.0)
            prev = t
        }
        assertEquals(0, ts.discontinuities)
    }

    @Test
    fun timestampsFollowSlowDriftAndReanchorOnGaps() {
        val ts = ChunkTimestamper(48_000)
        // Audio clock 100 ppm slower than system clock.
        var t = 0.0
        for (i in 0 until 3000) t = ts.timestampFor(i * 960L, i * 20.0 * 1.0001)
        assertEquals(2999 * 20.0 * 1.0001, t, 2.0)
        // A single 80 ms measurement spike is ignored (timeline stays continuous)...
        val spike = ts.timestampFor(3000 * 960L, 3000 * 20.0 * 1.0001 + 80)
        assertEquals(t + 20.0 * 1.0001, spike, 0.5)
        assertEquals(0, ts.discontinuities)
        // ...but a 500 ms gap (frames lost) that persists for 3 chunks causes a re-anchor.
        var after = 0.0
        for (k in 3001..3003) after = ts.timestampFor(k * 960L, k * 20.0 * 1.0001 + 500)
        assertEquals(3003 * 20.0 * 1.0001 + 500, after, 0.05)
        assertEquals(1, ts.discontinuities)
    }

    @Test
    fun alignerPlans() {
        val a = PlaybackAligner(48_000, 2)
        assertEquals(PlaybackAligner.Plan(4800, 0, 0), a.plan(-100.0, 960))
        assertEquals(PlaybackAligner.Plan(0, 960, 0), a.plan(500.0, 960))
        assertEquals(PlaybackAligner.Plan(0, 960, 0), a.plan(50.0, 960)) // 2400 frames late, capped to the chunk
        assertEquals(PlaybackAligner.Plan(0, 960, 0), a.plan(30.0, 960)) // > 25 ms late: skip (capped to the chunk)
        assertEquals(PlaybackAligner.Plan(0, 0, 4), a.plan(20.0, 960))
        assertEquals(PlaybackAligner.Plan(0, 0, 1), a.plan(3.0, 960))
        assertEquals(PlaybackAligner.Plan(0, 0, -2), a.plan(-10.0, 960))
        assertEquals(PlaybackAligner.Plan(0, 0, 0), a.plan(1.0, 960))

        val chunk = ShortArray(8) { it.toShort() } // 4 stereo frames: (0,1) (2,3) (4,5) (6,7)
        assertEquals(listOf<Short>(0, 1, 2, 3, 6, 7), a.apply(PlaybackAligner.Plan(0, 0, 1), chunk).toList())
        assertEquals(listOf<Short>(0, 1, 2, 3, 4, 5, 4, 5, 6, 7), a.apply(PlaybackAligner.Plan(0, 0, -1), chunk).toList())
        assertEquals(listOf<Short>(4, 5, 6, 7), a.apply(PlaybackAligner.Plan(0, 2, 0), chunk).toList())

        // Real-size chunk: 4 frames dropped / repeated, spread out, frame order preserved.
        val big = ShortArray(960 * 2) { (it / 2).toShort() }
        val dropped = a.apply(PlaybackAligner.Plan(0, 0, 4), big)
        assertEquals((960 - 4) * 2, dropped.size)
        val repeated = a.apply(PlaybackAligner.Plan(0, 0, -4), big)
        assertEquals((960 + 4) * 2, repeated.size)
        for (i in 2 until dropped.size step 2) assertTrue(dropped[i] > dropped[i - 2])
        for (i in 2 until repeated.size step 2) assertTrue(repeated[i] >= repeated[i - 2])
    }

    @Test
    fun levelMeter() {
        assertEquals(-90f, Level.of(ShortArray(100)).db, 0.01f)
        val sine = ShortArray(4800) { (sin(2 * PI * 440 * it / 48000.0) * 16384).toInt().toShort() }
        val l = Level.of(sine)
        assertEquals(0.5f, l.peak, 0.01f)
        assertEquals(-9.03f, l.db, 0.2f) // 0.5 amplitude sine = -6 dB peak, -9 dB RMS
        assertTrue(l.meter > 0.8f)
    }
}
