package com.syncspeaker.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.widget.Toast

/**
 * Shared permission flow: RECORD_AUDIO (+ notifications) -> MediaProjection consent -> service.
 * Plain framework Activity APIs, so the app has no AndroidX dependency.
 */
abstract class ProjectionActivity : Activity() {
    private var pendingMode = PartyState.Mode.PARTY

    /**
     * Automation hook (used by the CI emulator test, handy for adb too):
     *   adb shell am start -n com.syncspeaker.app/.MainActivity --ez autostart true
     * starts the same flow as tapping the button (permission prompts still apply).
     */
    protected fun handleAutostart(intent: Intent?, mode: PartyState.Mode) {
        if (intent?.getBooleanExtra(EXTRA_AUTOSTART, false) == true && PartyState.snapshot.mode != mode) {
            intent.removeExtra(EXTRA_AUTOSTART)
            beginCapture(mode)
        }
    }

    protected fun beginCapture(mode: PartyState.Mode) {
        pendingMode = mode
        val needed = mutableListOf<String>()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed += Manifest.permission.RECORD_AUDIO
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        if (needed.isEmpty()) requestProjection() else requestPermissions(needed.toTypedArray(), REQ_PERMISSIONS)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMISSIONS) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            requestProjection()
        } else {
            Toast.makeText(this, R.string.need_record_permission, Toast.LENGTH_LONG).show()
        }
    }

    private fun requestProjection() {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val intent = if (Build.VERSION.SDK_INT >= 34) {
            // Audio capture needs a full-screen projection; skip the "share one app" option.
            mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            mpm.createScreenCaptureIntent()
        }
        startActivityForResult(intent, REQ_PROJECTION)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PROJECTION) return
        if (resultCode == RESULT_OK && data != null) {
            PartyService.start(this, resultCode, data, pendingMode)
        } else {
            Toast.makeText(this, R.string.need_projection_permission, Toast.LENGTH_LONG).show()
        }
    }

    companion object {
        const val EXTRA_AUTOSTART = "autostart"
        private const val REQ_PERMISSIONS = 10
        private const val REQ_PROJECTION = 11
    }
}
