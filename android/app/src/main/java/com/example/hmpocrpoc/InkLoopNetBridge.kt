package com.example.hmpocrpoc

import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * JS↔原生桥：window.InkLoopNet —— 无线同步链路的状态读取 + 切换入口（dev 页「同步链路」卡）。
 *
 * 背景：Mac 侧 sync-wifi.sh 通过「同 WiFi + adb-over-TCP(5555)」无线拉取 vault，
 * 演示/日常需要在设备上不插 USB 就能看到"我现在有没有 IP、连的哪个网"，以及
 * 一键跳到系统开关页在 WiFi(直连路) 和 热点(无局域网应急路) 之间切换。
 *
 * 普通 app 在 Android 10+ 没有系统权限，程序化开关 WiFi/热点做不到——所以本桥只做
 * 「读状态 + 拉起系统面板」，实际开关由用户在系统页上点（这也是演示上更稳的路）。
 *
 * 前端契约（src/mobile/dev.ts，无桥时整卡隐藏）：
 *   getState(): String   → JSON {wifiEnabled:boolean, ip?:"192.168.x.x", ssid?:string, error?:string}
 *   openWifiPanel()      → Android 10+ 底部 WiFi 快捷面板（低版本退化到 WiFi 设置页）
 *   openTetherSettings() → 系统「热点和网络共享」页（M103 实测组件名 Settings$TetherSettingsActivity）
 */
object InkLoopNetBridge {
    fun attach(webView: WebView, context: Context) {
        webView.addJavascriptInterface(JsApi(context.applicationContext), "InkLoopNet")
    }

    private class JsApi(private val ctx: Context) {
        @JavascriptInterface
        fun getState(): String {
            val o = JSONObject()
            try {
                val wm = ctx.getSystemService(Context.WIFI_SERVICE) as WifiManager
                o.put("wifiEnabled", wm.isWifiEnabled)
                @Suppress("DEPRECATION") val info = wm.connectionInfo
                val ip = info?.ipAddress ?: 0
                if (ip != 0) o.put(
                    "ip",
                    "${ip and 0xff}.${ip shr 8 and 0xff}.${ip shr 16 and 0xff}.${ip shr 24 and 0xff}",
                )
                // Android 8.1+ 无定位权限时 SSID 是 "<unknown ssid>"——IP 才是主信息，SSID 尽力而为
                val ssid = info?.ssid?.trim('"')
                if (!ssid.isNullOrBlank() && ssid != "<unknown ssid>") o.put("ssid", ssid)
            } catch (e: Exception) {
                o.put("error", e.message ?: e.javaClass.simpleName)
            }
            return o.toString()
        }

        @JavascriptInterface
        fun openWifiPanel() {
            val panel = if (Build.VERSION.SDK_INT >= 29) Intent(Settings.Panel.ACTION_WIFI) else null
            startFirst(panel, Intent(Settings.ACTION_WIFI_SETTINGS))
        }

        @JavascriptInterface
        fun openTetherSettings() {
            val direct = Intent().setClassName(
                "com.android.settings",
                "com.android.settings.Settings\$TetherSettingsActivity",
            )
            startFirst(direct, Intent(Settings.ACTION_WIRELESS_SETTINGS))
        }

        private fun startFirst(vararg intents: Intent?) {
            for (i in intents) {
                if (i == null) continue
                try {
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    ctx.startActivity(i)
                    return
                } catch (_: Exception) { /* 试下一个 */ }
            }
        }
    }
}
