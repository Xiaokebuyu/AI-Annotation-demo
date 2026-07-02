package com.example.hmpocrpoc

import android.os.IBinder
import android.os.Parcel
import android.util.Log

/**
 * RkEinkBridge —— Haoqing M103（RK3566 原生 EBC 电纸屏，DIRECT 显示、非 IT8951 USB 外接）的刷新桥。
 *
 * 2026-07-01：最初做过"落笔切 A2 快刷、停笔/翻页切 GC16 整屏清残影"的实时切换，
 * 但两轮真机排查（含 codex full-access 用 `sendevent` 注入真实笔迹信号实测）确认：
 * - `sys.eink.mode` 只影响 HWC 主内容层；这台设备还有一条独立的厂商 `haoqingdrawserver`
 *   守护进程直接监听 `/dev/input/event3`(huion 触控笔) 管自己的 OSD/笔迹叠加层缓冲，
 *   app 层完全够不着这条路——不管我们怎么切 mode，这条独立路径都不受控制。
 * - 固定 `sys.eink.mode=7`(设备原厂默认值，`sys.eink.one_full_mode_timeline` 显示厂商自己
 *   维护周期性整屏清屏) 全程不切换，真机注入 12 笔触控笔轨迹验证过全程无残留；
 *   反之强制切 A2(4) 复现残影 bug，强制切 GC16(2) 会被厂商自己的逻辑主动拉回 7。
 * 结论：app 层做不到、也不该做实时精细控制，直接固定用设备原厂默认 mode，交给厂商自己的
 * 刷新策略处理。不再往前端注入 `window.InkLoopEink`——没有消息要处理，`eink.ts` 在这类设备上
 * 自然走 `einkAvailable()=false` 的 no-op 分支（跟 Phase 0 未接桥时行为一致）。
 */
object RkEinkBridge {
    private const val TAG = "RkEinkBridge"
    private const val FIXED_MODE = 7

    @JvmStatic
    fun attach() {
        Log.i(TAG, "ensureFixedMode($FIXED_MODE) ok=${EinkManagerBridge.applyMode(FIXED_MODE)}")
    }

    private object EinkManagerBridge {
        private const val SERVICE_NAME = "eink"
        private const val DESCRIPTOR = "android.os.IEinkManager"
        private const val TRANSACTION_SET_PROPERTY = 5
        private const val PROP_EINK_MODE = "sys.eink.mode"

        @Volatile private var cached: IBinder? = null

        fun applyMode(mode: Int): Boolean {
            val b = service() ?: return false
            return setProperty(b, PROP_EINK_MODE, mode.toString())
        }

        @Suppress("PrivateApi")
        private fun service(): IBinder? {
            cached?.let { if (it.isBinderAlive) return it }
            return try {
                val cls = Class.forName("android.os.ServiceManager")
                val m = cls.getDeclaredMethod("getService", String::class.java)
                (m.invoke(null, SERVICE_NAME) as? IBinder)?.also { b ->
                    cached = b
                    try { b.linkToDeath({ cached = null }, 0) } catch (_: Throwable) {}
                }
            } catch (_: Throwable) { null }
        }

        private fun setProperty(b: IBinder, key: String, value: String): Boolean {
            val data = Parcel.obtain()
            val reply = Parcel.obtain()
            return try {
                data.writeInterfaceToken(DESCRIPTOR)
                data.writeString(key)
                data.writeString(value)
                if (!b.transact(TRANSACTION_SET_PROPERTY, data, reply, 0)) return false
                reply.readException()
                true
            } catch (t: Throwable) {
                cached = null
                Log.w(TAG, "setProperty($key=$value) failed: ${t.javaClass.simpleName}: ${t.message}")
                false
            } finally {
                reply.recycle()
                data.recycle()
            }
        }
    }
}
