package com.syncspeaker.testsource

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.TextView

/** Starts [BeepService] (a beep at the start of every second, USAGE_MEDIA). */
class BeepActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = "Beep source: one beep per second"; textSize = 24f; setPadding(48, 96, 48, 48) })
        startForegroundService(Intent(this, BeepService::class.java))
    }
}
