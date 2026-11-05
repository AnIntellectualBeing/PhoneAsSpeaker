package com.syncspeaker.app.server

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The SyncSpeaker wire protocol (version 1). See PROTOCOL.md in the repository root.
 *
 * This file must stay free of Android imports so it can be unit-tested on the JVM.
 *
 * Binary frames (host -> listener):
 *   [8 bytes: float64 little-endian, capture time of the first sample, host clock in ms]
 *   [payload: audio encoded with the codec announced in "hello" (v1: pcm_s16le, interleaved)]
 *
 * Text frames are small JSON objects with a "type" field:
 *   host -> listener: hello, pong
 *   listener -> host: ping
 */
object Protocol {
    const val VERSION = 1
    const val HEADER_BYTES = 8
    const val WS_PATH = "/ws"

    /** Monotonic host clock in milliseconds (same base as AudioTimestamp.TIMEBASE_MONOTONIC). */
    fun hostNowMs(): Double = System.nanoTime() / 1_000_000.0

    fun audioPacket(timestampMs: Double, payload: ByteArray, offset: Int = 0, length: Int = payload.size): ByteArray {
        val out = ByteArray(HEADER_BYTES + length)
        ByteBuffer.wrap(out, 0, HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN).putDouble(timestampMs)
        System.arraycopy(payload, offset, out, HEADER_BYTES, length)
        return out
    }

    fun readTimestamp(packet: ByteArray): Double =
        ByteBuffer.wrap(packet, 0, HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN).double

    fun hello(format: StreamFormat, delayMs: Int, sessionId: String, serverTimeMs: Double): String =
        "{\"type\":\"hello\",\"protocol\":$VERSION,\"codec\":\"${format.codec}\"," +
            "\"sampleRate\":${format.sampleRate},\"channels\":${format.channels}," +
            "\"delayMs\":$delayMs,\"session\":\"$sessionId\",\"serverTime\":${num(serverTimeMs)}}"

    /**
     * NTP-style reply. t0 = listener send time (echoed), t1 = host receive time,
     * t2 = host send time. The listener records t3 on receipt.
     */
    fun pong(id: Long, t0: Double, t1: Double, t2: Double): String =
        "{\"type\":\"pong\",\"id\":$id,\"t0\":${num(t0)},\"t1\":${num(t1)},\"t2\":${num(t2)}}"

    data class Ping(val id: Long, val t0: Double)

    /** Listener status, sent every few seconds: {"type":"report","name":"iPhone","state":"playing","syncMs":3.2} */
    data class Report(val name: String, val state: String, val syncMs: Double)

    private val typeRe = Regex("\"type\"\\s*:\\s*\"([a-z]+)\"")
    private val idRe = Regex("\"id\"\\s*:\\s*(-?\\d+)")
    private val t0Re = Regex("\"t0\"\\s*:\\s*(-?[0-9.eE+-]+)")

    private val nameRe = Regex("\"name\"\\s*:\\s*\"([^\"\\\\]{0,40})\"")
    private val stateRe = Regex("\"state\"\\s*:\\s*\"([a-z]{1,16})\"")
    private val syncRe = Regex("\"syncMs\"\\s*:\\s*(-?[0-9.eE+-]+)")

    fun messageType(json: String): String? = typeRe.find(json)?.groupValues?.get(1)

    fun parseReport(json: String): Report? {
        if (messageType(json) != "report") return null
        val name = nameRe.find(json)?.groupValues?.get(1)?.trim()?.take(24)?.ifEmpty { null } ?: "Phone"
        val state = stateRe.find(json)?.groupValues?.get(1) ?: "unknown"
        val sync = syncRe.find(json)?.groupValues?.get(1)?.toDoubleOrNull() ?: Double.NaN
        return Report(name, state, sync)
    }

    /** Minimal parser for {"type":"ping","id":1,"t0":123.4}. Returns null for anything else. */
    fun parsePing(json: String): Ping? {
        if (messageType(json) != "ping") return null
        val id = idRe.find(json)?.groupValues?.get(1)?.toLongOrNull() ?: return null
        val t0 = t0Re.find(json)?.groupValues?.get(1)?.toDoubleOrNull() ?: return null
        return Ping(id, t0)
    }

    private fun num(v: Double): String = if (v.isFinite()) String.format(java.util.Locale.ROOT, "%.4f", v) else "0"
}

/** Describes the audio stream. v1 always sends raw 16-bit PCM. */
data class StreamFormat(
    val sampleRate: Int = 48_000,
    val channels: Int = 2,
    val codec: String = "pcm_s16le",
)

/**
 * Hook for compressing audio before it is sent.
 *
 * TODO(opus): add an OpusEncoder (e.g. via MediaCodec "audio/opus" on Android 10+), announce
 *  codec "opus" in hello, and add a matching decoder in web/listener/syncspeaker.js. Note that
 *  WebCodecs' AudioDecoder needs a secure context (HTTPS), so the listener would need a small
 *  WASM Opus decoder instead because the page is served over plain http on the LAN.
 */
interface AudioEncoder {
    val codec: String
    /** Encodes one chunk of interleaved little-endian 16-bit PCM. */
    fun encode(pcm: ByteArray, offset: Int, length: Int): ByteArray
}

/** v1 "encoder": passes raw PCM through unchanged (~1.5 Mbit/s per listener at 48 kHz stereo). */
class PcmEncoder : AudioEncoder {
    override val codec = "pcm_s16le"
    override fun encode(pcm: ByteArray, offset: Int, length: Int): ByteArray = pcm.copyOfRange(offset, offset + length)
}
