package com.syncspeaker.app

import android.os.Handler
import android.os.Looper
import com.syncspeaker.app.core.Level
import com.syncspeaker.app.server.StreamServer
import java.util.concurrent.CopyOnWriteArraySet

/** What the foreground service is doing, observed by the activities (always on the main thread). */
object PartyState {
    enum class Mode { IDLE, PARTY, CAPTURE_TEST }

    data class Snapshot(
        val mode: Mode = Mode.IDLE,
        val listeners: Int = 0,
        /** Listener URLs, best first (e.g. http://192.168.1.23:8080). */
        val urls: List<String> = emptyList(),
        val level: Level = Level.SILENT,
        /** Host-clock time of the last chunk that was louder than -50 dBFS. */
        val lastSoundMs: Double = 0.0,
        val captureStartedMs: Double = 0.0,
        val error: String? = null,
        val localPlayback: Boolean = false,
        val listenerInfo: List<StreamServer.ListenerInfo> = emptyList(),
    )

    private val main = Handler(Looper.getMainLooper())
    private val observers = CopyOnWriteArraySet<(Snapshot) -> Unit>()

    @Volatile
    var snapshot = Snapshot()
        private set

    fun update(change: (Snapshot) -> Snapshot) {
        synchronized(this) { snapshot = change(snapshot) }
        main.post { val s = snapshot; for (o in observers) o(s) }
    }

    fun observe(observer: (Snapshot) -> Unit) {
        observers.add(observer)
        observer(snapshot)
    }

    fun unobserve(observer: (Snapshot) -> Unit) {
        observers.remove(observer)
    }
}
