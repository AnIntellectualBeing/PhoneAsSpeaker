package com.syncspeaker.app

import android.content.Context

/** Host settings, persisted in SharedPreferences. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("syncspeaker", Context.MODE_PRIVATE)

    var playLocally: Boolean
        get() = sp.getBoolean("play_locally", false)
        set(v) = sp.edit().putBoolean("play_locally", v).apply()

    /** Play the synced stream on the alarm volume channel, so media volume can be set to zero. */
    var useAlarmStream: Boolean
        get() = sp.getBoolean("alarm_stream", false)
        set(v) = sp.edit().putBoolean("alarm_stream", v).apply()

    var delayMs: Int
        get() = sp.getInt("delay_ms", DEFAULT_DELAY_MS)
        set(v) = sp.edit().putInt("delay_ms", v).apply()

    var keepScreenOn: Boolean
        get() = sp.getBoolean("keep_screen_on", true)
        set(v) = sp.edit().putBoolean("keep_screen_on", v).apply()

    companion object {
        const val DEFAULT_DELAY_MS = 1000
        const val MIN_DELAY_MS = 300
        const val MAX_DELAY_MS = 3000
    }
}
