package com.syncspeaker.app.server

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class StreamServerTest {
    private lateinit var server: StreamServer
    private var port = 0
    private val http = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build()

    @Before
    fun setUp() {
        port = ServerSocket(0).use { it.localPort }
        server = StreamServer(port, { path ->
            if (path == "index.html") "<html>listener</html>".toByteArray() else null
        })
        server.delayMs = 1234
        server.startServer()
    }

    @After
    fun tearDown() {
        server.stopServer()
    }

    @Test
    fun servesListenerPage() {
        http.newCall(Request.Builder().url("http://127.0.0.1:$port/").build()).execute().use { r ->
            assertEquals(200, r.code)
            assertEquals("<html>listener</html>", r.body!!.string())
            assertTrue(r.header("Content-Type")!!.startsWith("text/html"))
        }
        http.newCall(Request.Builder().url("http://127.0.0.1:$port/../secret").build()).execute().use { r ->
            assertTrue(r.code == 403 || r.code == 404)
        }
        http.newCall(Request.Builder().url("http://127.0.0.1:$port/missing.js").build()).execute().use { r ->
            assertEquals(404, r.code)
        }
    }

    @Test
    fun helloPongAndAudio() {
        val texts = LinkedBlockingQueue<String>()
        val binaries = LinkedBlockingQueue<ByteArray>()
        val opened = CountDownLatch(1)
        val ws = http.newWebSocket(
            Request.Builder().url("ws://127.0.0.1:$port/ws").build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) { opened.countDown() }
                override fun onMessage(webSocket: WebSocket, text: String) { texts.add(text) }
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) { binaries.add(bytes.toByteArray()) }
            },
        )
        assertTrue(opened.await(5, TimeUnit.SECONDS))

        val hello = texts.poll(5, TimeUnit.SECONDS)
        assertNotNull(hello)
        assertEquals("hello", Protocol.messageType(hello!!))
        assertTrue(hello.contains("\"delayMs\":1234"))
        assertTrue(hello.contains("\"sampleRate\":48000"))

        // Wait until the server registered the listener.
        val deadline = System.currentTimeMillis() + 5000
        while (server.listenerCount == 0 && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertEquals(1, server.listenerCount)

        ws.send("{\"type\":\"ping\",\"id\":7,\"t0\":12.5}")
        val pong = texts.poll(5, TimeUnit.SECONDS)
        assertNotNull(pong)
        assertEquals("pong", Protocol.messageType(pong!!))
        assertTrue(pong, pong.contains("\"id\":7"))
        assertTrue(pong, pong.contains("\"t0\":12.5"))

        val pcm = ByteArray(3840) { (it % 251).toByte() }
        server.broadcastAudio(98765.4321, pcm)
        val packet = binaries.poll(5, TimeUnit.SECONDS)
        assertNotNull(packet)
        assertEquals(8 + pcm.size, packet!!.size)
        assertEquals(98765.4321, Protocol.readTimestamp(packet), 1e-9)
        assertEquals(pcm.toList(), packet.copyOfRange(8, packet.size).toList())

        ws.send("{\"type\":\"report\",\"name\":\"Test phone\",\"state\":\"playing\",\"syncMs\":4.5}")
        val deadline3 = System.currentTimeMillis() + 5000
        while (server.listenerInfo().firstOrNull()?.name != "Test phone" && System.currentTimeMillis() < deadline3) Thread.sleep(10)
        assertEquals(StreamServer.ListenerInfo("Test phone", "playing", 4.5, "127.0.0.1"), server.listenerInfo().first())

        ws.close(1000, "bye")
        val deadline2 = System.currentTimeMillis() + 5000
        while (server.listenerCount != 0 && System.currentTimeMillis() < deadline2) Thread.sleep(10)
        assertEquals(0, server.listenerCount)
    }

    @Test
    fun parsesReport() {
        val r = Protocol.parseReport("{\"type\":\"report\",\"name\":\"iPhone\",\"state\":\"playing\",\"syncMs\":3.25}")
        assertEquals(Protocol.Report("iPhone", "playing", 3.25), r)
        val bad = Protocol.parseReport("{\"type\":\"report\",\"name\":\"\\\"evil\",\"syncMs\":\"x\"}")
        assertEquals("Phone", bad!!.name)
        assertTrue(bad.syncMs.isNaN())
    }

    @Test
    fun parsesPing() {
        assertEquals(Protocol.Ping(3, 1.5e3), Protocol.parsePing("{\"type\":\"ping\",\"id\":3,\"t0\":1500}"))
        assertEquals(null, Protocol.parsePing("{\"type\":\"other\",\"id\":3,\"t0\":1}"))
    }
}
