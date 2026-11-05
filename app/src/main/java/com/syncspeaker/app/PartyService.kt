package com.syncspeaker.app

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import com.syncspeaker.app.audio.CaptureEngine
import com.syncspeaker.app.audio.LocalPlayer
import com.syncspeaker.app.server.Protocol
import com.syncspeaker.app.server.StreamFormat
import com.syncspeaker.app.server.StreamServer
import java.io.IOException

/**
 * Foreground service (type mediaProjection) that keeps the party running while the phone is
 * locked or another app (Spotify, YouTube Music, ...) is in front.
 *
 * Owns: the MediaProjection, the [CaptureEngine], the [StreamServer] and the optional [LocalPlayer].
 */
class PartyService : Service() {

    private val main = Handler(Looper.getMainLooper())
    private var projection: MediaProjection? = null
    private var capture: CaptureEngine? = null
    private var server: StreamServer? = null
    @Volatile private var localPlayer: LocalPlayer? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var mode = PartyState.Mode.IDLE
    private var port = StreamServer.DEFAULT_PORT

    private val refreshUrls = object : Runnable {
        override fun run() {
            if (mode == PartyState.Mode.PARTY) {
                val urls = NetworkUtils.listenerUrls(port)
                if (urls != PartyState.snapshot.urls) {
                    PartyState.update { it.copy(urls = urls) }
                    updateNotification()
                }
                val info = server?.listenerInfo().orEmpty()
                if (info != PartyState.snapshot.listenerInfo) PartyState.update { it.copy(listenerInfo = info) }
                main.postDelayed(this, 2000)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand ${intent?.action} mode=${intent?.getStringExtra(EXTRA_MODE)}")
        when (intent?.action) {
            ACTION_STOP -> {
                stopEverything()
                stopSelf()
            }
            ACTION_START -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                @Suppress("DEPRECATION")
                val data: Intent? = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
                } else {
                    intent.getParcelableExtra(EXTRA_RESULT_DATA)
                }
                val newMode = PartyState.Mode.valueOf(intent.getStringExtra(EXTRA_MODE) ?: PartyState.Mode.PARTY.name)
                stopEverything()
                // startForeground MUST happen before getMediaProjection() on Android 10+.
                goForeground(newMode)
                if (data == null || !startEverything(newMode, resultCode, data)) {
                    stopEverything()
                    stopSelf()
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun goForeground(newMode: PartyState.Mode) {
        mode = newMode
        val notification = buildNotification()
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        if (Build.VERSION.SDK_INT >= 30) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        try {
            startForeground(NOTIFICATION_ID, notification, type)
        } catch (e: Exception) {
            // E.g. microphone type refused: fall back to mediaProjection only.
            Log.w(TAG, "startForeground with microphone type failed, retrying", e)
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        }
    }

    private fun startEverything(newMode: PartyState.Mode, resultCode: Int, data: Intent): Boolean {
        val prefs = Prefs(this)
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val proj = try {
            mpm.getMediaProjection(resultCode, data)
        } catch (e: Exception) {
            Log.e(TAG, "getMediaProjection failed", e)
            null
        }
        if (proj == null) {
            PartyState.update { it.copy(mode = PartyState.Mode.IDLE, error = "Screen/audio sharing permission was not granted.") }
            return false
        }
        projection = proj
        Log.i(TAG, "MediaProjection acquired, starting $newMode")
        proj.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                // The user stopped sharing from the system UI (status bar chip, lock, ...).
                // Only react if THIS projection is still the active one: when a new party/test
                // replaces an old one, the old projection's onStop arrives after the new start.
                main.post {
                    if (projection === proj) {
                        Log.i(TAG, "MediaProjection stopped by the system/user")
                        stopEverything()
                        stopSelf()
                    }
                }
            }
        }, main)

        acquireLocks()

        if (newMode == PartyState.Mode.PARTY) {
            val srv = startServer() ?: run {
                PartyState.update { it.copy(mode = PartyState.Mode.IDLE, error = "Could not open a network port (8080-8089 all busy).") }
                return false
            }
            server = srv
            srv.format = StreamFormat(CaptureEngine.SAMPLE_RATE, CaptureEngine.CHANNELS)
            srv.delayMs = prefs.delayMs
            srv.onListenerCountChanged = { n ->
                PartyState.update { it.copy(listeners = n) }
                main.post { updateNotification() }
            }
            if (prefs.playLocally) setLocalPlayback(true)
            Log.i(TAG, "server listening on port $port, urls=${NetworkUtils.listenerUrls(port)}")
        }

        val now = Protocol.hostNowMs()
        PartyState.update {
            it.copy(
                mode = newMode, listeners = 0, error = null, captureStartedMs = now, lastSoundMs = 0.0,
                urls = if (newMode == PartyState.Mode.PARTY) NetworkUtils.listenerUrls(port) else emptyList(),
            )
        }
        updateNotification()
        main.post(refreshUrls)

        capture = CaptureEngine(
            proj,
            onChunk = { ts, bytes, samples ->
                server?.broadcastAudio(ts, bytes)
                localPlayer?.enqueue(ts, samples)
            },
            onLevel = { level ->
                PartyState.update {
                    it.copy(level = level, lastSoundMs = if (level.db > -50f) Protocol.hostNowMs() else it.lastSoundMs)
                }
            },
            onError = { msg ->
                PartyState.update { it.copy(error = msg) }
            },
        ).also { it.start() }
        return true
    }

    private fun startServer(): StreamServer? {
        for (p in StreamServer.DEFAULT_PORT..StreamServer.DEFAULT_PORT + 9) {
            val srv = StreamServer(p, assets = { path -> readAsset(path) }, log = { Log.i("StreamServer", it) })
            try {
                srv.startServer()
                port = p
                return srv
            } catch (e: IOException) {
                Log.w(TAG, "Port $p unavailable: ${e.message}")
            }
        }
        return null
    }

    private fun readAsset(path: String): ByteArray? = try {
        assets.open(path).use { it.readBytes() }
    } catch (_: IOException) {
        null
    }

    /** Turns "Play on this phone too" on or off while the party is running. */
    fun setLocalPlayback(enabled: Boolean) {
        localPlayer?.stop()
        localPlayer = null
        if (enabled && mode == PartyState.Mode.PARTY) {
            val prefs = Prefs(this)
            localPlayer = LocalPlayer(CaptureEngine.SAMPLE_RATE, CaptureEngine.CHANNELS, prefs.delayMs, prefs.useAlarmStream)
                .also { it.start() }
        }
        PartyState.update { it.copy(localPlayback = localPlayer != null) }
    }

    fun setDelay(delayMs: Int) {
        server?.delayMs = delayMs
        localPlayer?.delayMs = delayMs
    }

    private fun stopEverything() {
        main.removeCallbacks(refreshUrls)
        capture?.stop()
        capture = null
        localPlayer?.stop()
        localPlayer = null
        server?.let {
            it.onListenerCountChanged = null
            it.stopServer()
        }
        server = null
        val p = projection
        projection = null
        try { p?.stop() } catch (_: Exception) {}
        releaseLocks()
        mode = PartyState.Mode.IDLE
        PartyState.update {
            it.copy(
                mode = PartyState.Mode.IDLE, listeners = 0, urls = emptyList(), level = com.syncspeaker.app.core.Level.SILENT,
                localPlayback = false, listenerInfo = emptyList(),
            )
        }
    }

    @Suppress("DEPRECATION")
    private fun acquireLocks() {
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SyncSpeaker:party").apply {
            setReferenceCounted(false)
            acquire(12 * 60 * 60 * 1000L)
        }
        val wm = applicationContext.getSystemService(WifiManager::class.java)
        val lockType = if (Build.VERSION.SDK_INT >= 34) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifiLock = wm?.createWifiLock(lockType, "SyncSpeaker:wifi")?.apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseLocks() {
        try { wakeLock?.release() } catch (_: Exception) {}
        try { wifiLock?.release() } catch (_: Exception) {}
        wakeLock = null
        wifiLock = null
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW)
        channel.setShowBadge(false)
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, if (mode == PartyState.Mode.CAPTURE_TEST) CaptureTestActivity::class.java else MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, PartyService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val s = PartyState.snapshot
        val title = if (mode == PartyState.Mode.CAPTURE_TEST) getString(R.string.notification_test_title) else getString(R.string.notification_party_title)
        val text = if (mode == PartyState.Mode.PARTY) {
            val url = s.urls.firstOrNull() ?: getString(R.string.no_network)
            resources.getQuantityString(R.plurals.listener_count, s.listeners, s.listeners) + " · " + url
        } else {
            getString(R.string.notification_test_text)
        }
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(Notification.Action.Builder(null, getString(R.string.stop), stop).build())
            .build()
    }

    private fun updateNotification() {
        if (mode == PartyState.Mode.IDLE) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    override fun onDestroy() {
        stopEverything()
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "PartyService"
        private const val CHANNEL_ID = "party"
        private const val NOTIFICATION_ID = 1
        const val ACTION_START = "com.syncspeaker.app.START"
        const val ACTION_STOP = "com.syncspeaker.app.STOP"
        private const val EXTRA_RESULT_CODE = "resultCode"
        private const val EXTRA_RESULT_DATA = "resultData"
        private const val EXTRA_MODE = "mode"

        @Volatile
        var instance: PartyService? = null
            private set

        fun start(context: Context, resultCode: Int, data: Intent, mode: PartyState.Mode) {
            val i = Intent(context, PartyService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, data)
                .putExtra(EXTRA_MODE, mode.name)
            context.startForegroundService(i)
        }

        fun stop(context: Context) {
            if (instance == null) return
            context.startService(Intent(context, PartyService::class.java).setAction(ACTION_STOP))
        }
    }
}
