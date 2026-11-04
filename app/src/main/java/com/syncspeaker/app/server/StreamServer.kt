package com.syncspeaker.app.server

import fi.iki.elonen.NanoHTTPD.ClientHandler
import fi.iki.elonen.NanoHTTPD.IHTTPSession
import fi.iki.elonen.NanoHTTPD.MIME_PLAINTEXT
import fi.iki.elonen.NanoHTTPD.Method
import fi.iki.elonen.NanoHTTPD.Response
import fi.iki.elonen.NanoHTTPD.newFixedLengthResponse
import fi.iki.elonen.NanoWSD
import fi.iki.elonen.NanoWSD.WebSocket
import fi.iki.elonen.NanoWSD.WebSocketFrame
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Embedded HTTP + WebSocket server that runs on the host phone.
 *
 *  - `GET /` (and other static files) serves the listener web page from [assets].
 *  - `GET /ws` upgrades to a WebSocket that streams timestamped audio and answers clock pings.
 *
 * Every listener gets its own bounded send queue + sender thread, so one slow phone never
 * delays the others. Clock-sync pongs bypass the queue so their timing stays accurate.
 *
 * No Android imports: this class is unit-tested on the JVM (see StreamServerTest).
 */
class StreamServer(
    port: Int,
    private val assets: AssetProvider,
    private val clock: () -> Double = Protocol::hostNowMs,
    private val log: (String) -> Unit = {},
) : NanoWSD(port) {

    fun interface AssetProvider {
        /** Returns the bytes of a static file (e.g. "index.html"), or null if it does not exist. */
        fun read(path: String): ByteArray?
    }

    /** Called (from a server thread) whenever the number of connected listeners changes. */
    @Volatile var onListenerCountChanged: ((Int) -> Unit)? = null

    @Volatile var format: StreamFormat = StreamFormat()
        set(value) { field = value; broadcastHello() }

    @Volatile var delayMs: Int = 1000
        set(value) { field = value; broadcastHello() }

    /** Changes every time the server starts, so listeners know to reset their state. */
    val sessionId: String = UUID.randomUUID().toString().substring(0, 8)

    private val clients = CopyOnWriteArrayList<Listener>()
    val droppedPackets = AtomicLong()

    val listenerCount: Int get() = clients.size

    /** Starts listening. Clients ping every ~2.5 s, so a 30 s read timeout only kills dead sockets. */
    fun startServer() {
        start(SOCKET_TIMEOUT_MS, true)
        log("Server started on port $listeningPort")
    }

    fun stopServer() {
        for (c in clients) c.shutdown()
        clients.clear()
        stop()
    }

    /** Sends one audio chunk to every listener. Called from the capture thread. */
    fun broadcastAudio(timestampMs: Double, payload: ByteArray, offset: Int = 0, length: Int = payload.size) {
        if (clients.isEmpty()) return
        val packet = Protocol.audioPacket(timestampMs, payload, offset, length)
        for (c in clients) c.enqueue(packet)
    }

    private fun broadcastHello() {
        for (c in clients) c.sendHello()
    }

    override fun createClientHandler(finalAccept: Socket, inputStream: InputStream): ClientHandler {
        // Small control frames (pongs) must not be held back by Nagle's algorithm.
        try { finalAccept.tcpNoDelay = true } catch (_: Exception) {}
        return super.createClientHandler(finalAccept, inputStream)
    }

    override fun openWebSocket(handshake: IHTTPSession): WebSocket = Listener(handshake)

    override fun serve(session: IHTTPSession): Response {
        if (isWebsocketRequested(session) && session.uri != Protocol.WS_PATH) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found")
        }
        return super.serve(session)
    }

    override fun serveHttp(session: IHTTPSession): Response {
        if (session.method != Method.GET && session.method != Method.HEAD) {
            return newFixedLengthResponse(Response.Status.METHOD_NOT_ALLOWED, MIME_PLAINTEXT, "Method not allowed")
        }
        var path = session.uri.substringBefore('?').trimStart('/')
        if (path.isEmpty()) path = "index.html"
        if (path.contains("..") || path.contains('\\')) {
            return newFixedLengthResponse(Response.Status.FORBIDDEN, MIME_PLAINTEXT, "Forbidden")
        }
        if (path == "status.json") {
            val json = "{\"listeners\":${clients.size},\"session\":\"$sessionId\"," +
                "\"sampleRate\":${format.sampleRate},\"channels\":${format.channels},\"delayMs\":$delayMs}"
            return noCache(newFixedLengthResponse(Response.Status.OK, "application/json", json))
        }
        val bytes = assets.read(path)
            ?: return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found")
        val resp = newFixedLengthResponse(Response.Status.OK, mimeFor(path), ByteArrayInputStream(bytes), bytes.size.toLong())
        return noCache(resp)
    }

    private fun noCache(r: Response): Response {
        r.addHeader("Cache-Control", "no-cache")
        return r
    }

    /** One connected listener phone. */
    private inner class Listener(handshake: IHTTPSession) : WebSocket(handshake) {
        private val queue = ArrayBlockingQueue<ByteArray>(QUEUE_CAPACITY)
        @Volatile private var running = false
        private var sender: Thread? = null
        private val remote = handshake.remoteIpAddress ?: "?"

        fun enqueue(packet: ByteArray) {
            if (!running) return
            if (!queue.offer(packet)) {
                // This listener is too slow (weak Wi-Fi). Drop the backlog; it will re-sync.
                queue.clear()
                droppedPackets.incrementAndGet()
                queue.offer(packet)
            }
        }

        fun sendHello() {
            try {
                send(Protocol.hello(format, delayMs, sessionId, clock()))
            } catch (e: IOException) {
                log("hello failed for $remote: ${e.message}")
            }
        }

        override fun onOpen() {
            running = true
            clients.add(this)
            log("Listener connected: $remote (total ${clients.size})")
            sendHello()
            sender = Thread({ sendLoop() }, "ws-send-$remote").apply {
                isDaemon = true
                priority = Thread.MAX_PRIORITY - 1
                start()
            }
            onListenerCountChanged?.invoke(clients.size)
        }

        private fun sendLoop() {
            try {
                while (running) {
                    val packet = queue.poll(500, TimeUnit.MILLISECONDS) ?: continue
                    send(packet)
                }
            } catch (_: InterruptedException) {
            } catch (e: IOException) {
                log("Send failed for $remote: ${e.message}")
                try { close(WebSocketFrame.CloseCode.AbnormalClosure, "send failed", false) } catch (_: Exception) {}
            }
        }

        fun shutdown() {
            running = false
            sender?.interrupt()
            try { close(WebSocketFrame.CloseCode.GoingAway, "server stopping", false) } catch (_: Exception) {}
        }

        override fun onClose(code: WebSocketFrame.CloseCode?, reason: String?, initiatedByRemote: Boolean) {
            running = false
            sender?.interrupt()
            queue.clear()
            if (clients.remove(this)) {
                log("Listener disconnected: $remote (total ${clients.size})")
                onListenerCountChanged?.invoke(clients.size)
            }
        }

        override fun onMessage(message: WebSocketFrame) {
            val t1 = clock()
            if (message.opCode != WebSocketFrame.OpCode.Text) return
            val text = message.textPayload ?: return
            val ping = Protocol.parsePing(text) ?: return
            try {
                // WebSocket.sendFrame is synchronized on this object; taking the same lock here
                // means t2 is read immediately before the bytes hit the socket.
                synchronized(this) {
                    send(Protocol.pong(ping.id, ping.t0, t1, clock()))
                }
            } catch (e: IOException) {
                log("pong failed for $remote: ${e.message}")
            }
        }

        override fun onPong(pong: WebSocketFrame?) {}

        override fun onException(exception: IOException?) {
            log("WebSocket error ($remote): ${exception?.message}")
        }
    }

    companion object {
        const val DEFAULT_PORT = 8080
        const val SOCKET_TIMEOUT_MS = 30_000
        /** ~3 seconds of 20 ms chunks. */
        const val QUEUE_CAPACITY = 150

        fun mimeFor(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
            "html", "htm" -> "text/html; charset=utf-8"
            "js", "mjs" -> "application/javascript; charset=utf-8"
            "css" -> "text/css; charset=utf-8"
            "json", "webmanifest" -> "application/json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "ico" -> "image/x-icon"
            "wav" -> "audio/wav"
            else -> "application/octet-stream"
        }
    }
}
