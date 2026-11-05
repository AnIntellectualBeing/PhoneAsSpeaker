package com.syncspeaker.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View

/** A horizontal level meter (green -> yellow -> red) with a falling peak-hold marker. */
class LevelMeterView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x33888888 }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val peakPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = context.getColor(R.color.text) }
    private val rect = RectF()
    private var value = 0f
    private var shown = 0f
    private var peak = 0f
    private var peakAt = 0L
    private var drawnPeak = 0f

    /**
     * @param level 0..1. Called ~20 times a second while capturing. The view redraws only when
     * something visibly changed (no continuous animation loop: saves battery and lets the UI go idle).
     */
    fun setLevel(level: Float) {
        value = level.coerceIn(0f, 1f)
        val now = SystemClock.uptimeMillis()
        if (value >= peak || now - peakAt > 1500) {
            peak = value
            peakAt = now
        }
        // Fast attack, slower release, for a pleasant needle.
        val next = if (value > shown) value else shown + (value - shown) * 0.35f
        if (kotlin.math.abs(next - shown) > 0.004f || kotlin.math.abs(peak - drawnPeak) > 0.004f) {
            shown = next
            invalidate()
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        fill.shader = LinearGradient(
            0f, 0f, w.toFloat(), 0f,
            intArrayOf(0xFF2ECC71.toInt(), 0xFF2ECC71.toInt(), 0xFFF1C40F.toInt(), 0xFFE74C3C.toInt()),
            floatArrayOf(0f, 0.6f, 0.85f, 1f), Shader.TileMode.CLAMP,
        )
    }

    override fun onDraw(canvas: Canvas) {
        val r = height / 2f
        rect.set(0f, 0f, width.toFloat(), height.toFloat())
        canvas.drawRoundRect(rect, r, r, track)
        drawnPeak = peak
        if (shown > 0.005f) {
            rect.set(0f, 0f, width * shown, height.toFloat())
            canvas.drawRoundRect(rect, r, r, fill)
        }
        if (peak > 0.01f) {
            val x = (width * peak).coerceIn(2f, width - 2f)
            canvas.drawRect(x - 2f, 0f, x + 2f, height.toFloat(), peakPaint)
        }
    }
}

/** Sets text only when it changed (avoids relayouts and accessibility events 20x a second). */
fun android.widget.TextView.setTextIfChanged(value: CharSequence) {
    if (text?.toString() != value.toString()) text = value
}

fun android.widget.TextView.setTextIfChanged(resId: Int) = setTextIfChanged(context.getText(resId))
