package com.syncspeaker.app.core

import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/** Audio level of one chunk. [peak] and [rms] are 0..1 linear; [db] is RMS in dBFS (-90..0). */
data class Level(val peak: Float, val rms: Float, val db: Float) {
    /** 0..1 value for a meter bar, mapping -60 dBFS..0 dBFS linearly. */
    val meter: Float get() = ((db + 60f) / 60f).coerceIn(0f, 1f)

    companion object {
        val SILENT = Level(0f, 0f, -90f)

        fun of(samples: ShortArray, count: Int = samples.size): Level {
            if (count <= 0) return SILENT
            var peak = 0
            var sum = 0.0
            for (i in 0 until count) {
                val s = samples[i].toInt()
                peak = max(peak, abs(s))
                sum += s.toDouble() * s
            }
            val rms = sqrt(sum / count) / 32768.0
            val db = if (rms <= 1e-9) -90.0 else max(-90.0, 20 * log10(rms))
            return Level((peak / 32768.0).toFloat(), rms.toFloat(), db.toFloat())
        }
    }
}
