package com.syncspeaker.app

import java.net.Inet4Address
import java.net.NetworkInterface

object NetworkUtils {
    data class LocalAddress(val iface: String, val ip: String)

    private val skipPrefixes = listOf("rmnet", "ccmni", "pdp", "v4-", "dummy", "tun", "ppp", "ims", "lo", "clat", "radio")

    /**
     * IPv4 addresses that other phones on the same Wi-Fi / hotspot can reach, best first.
     * Mobile-data and VPN interfaces are skipped.
     */
    fun localIpv4Addresses(): List<LocalAddress> {
        val out = mutableListOf<LocalAddress>()
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return emptyList()
            for (ni in ifaces) {
                val name = ni.name ?: continue
                if (!ni.isUp || ni.isLoopback) continue
                if (skipPrefixes.any { name.startsWith(it) }) continue
                for (addr in ni.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress && !addr.isLinkLocalAddress) {
                        out += LocalAddress(name, addr.hostAddress ?: continue)
                    }
                }
            }
        } catch (_: Exception) {
        }
        return out.sortedBy { rank(it) }
    }

    private fun rank(a: LocalAddress): Int = when {
        a.iface.startsWith("wlan") -> 0
        a.iface.startsWith("ap") || a.iface.startsWith("swlan") || a.iface.startsWith("softap") -> 1
        a.iface.startsWith("eth") || a.iface.startsWith("rndis") || a.iface.startsWith("usb") -> 2
        else -> 3
    }

    fun listenerUrls(port: Int): List<String> = localIpv4Addresses().map { "http://${it.ip}:$port" }.distinct()
}
