package com.venture.app.bridge

import android.util.Log
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 本地工具桥 HTTP 服务（对应规格书第 2 章"桥接层→原生层"通道）。
 *
 * 项目无 Tauri command 基础设施（前端与后端均走 localhost HTTP），
 * 因此原生层同样暴露 loopback HTTP 服务，供 Rust 后端 tool_router 转发原生工具调用：
 *
 *   POST http://127.0.0.1:46307/tool   { "tool": "click", "args": {...} }
 *     → { "ok": true, ... } / { "ok": false, "error": { "code", "message" } }
 *   GET  http://127.0.0.1:46307/health → { "ok": true, "service": "...", "operational": bool }
 *
 * 仅绑定 127.0.0.1，不对外暴露。请求体按 Content-Length 读取（不支持 chunked，后端不会用）。
 */
class ToolServer(
    private val port: Int = PORT,
    private val handler: (tool: String, args: JSONObject) -> JSONObject,
) {

    companion object {
        const val PORT = 46307
        private const val TAG = "VentureToolServer"
        private const val MAX_BODY_BYTES = 2 * 1024 * 1024

        @Volatile
        var instance: ToolServer? = null
            private set

        /** 幂等启动（MainActivity.onCreate 调用） */
        fun ensureStarted(handler: (tool: String, args: JSONObject) -> JSONObject): ToolServer {
            instance?.let { return it }
            synchronized(this) {
                instance?.let { return it }
                val server = ToolServer(PORT, handler)
                server.start()
                instance = server
                return server
            }
        }
    }

    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool()

    fun start() {
        if (!running.compareAndSet(false, true)) return
        pool.execute { serve() }
        Log.i(TAG, "ToolServer starting on 127.0.0.1:$port")
    }

    fun stop() {
        running.set(false)
        runCatching { serverSocket?.close() }
    }

    private fun serve() {
        try {
            val socket = ServerSocket(port, 50, InetAddress.getByName("127.0.0.1"))
            serverSocket = socket
            while (running.get()) {
                val client = runCatching { socket.accept() }.getOrNull() ?: break
                pool.execute { runCatching { handle(client) } }
            }
        } catch (e: Exception) {
            if (running.get()) Log.e(TAG, "serve failed", e)
        }
    }

    private fun handle(client: Socket) {
        client.soTimeout = 15_000
        client.use { sock ->
            val input = BufferedInputStream(sock.getInputStream())
            val output = sock.getOutputStream()

            // 请求行
            val requestLine = readLine(input) ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return respond(output, 400, errorJson("bad_request", "malformed request line"))
            val method = parts[0].uppercase()
            val path = parts[1].substringBefore('?')

            // 头
            var contentLength = 0
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0) {
                    val name = line.substring(0, idx).trim().lowercase()
                    val value = line.substring(idx + 1).trim()
                    if (name == "content-length") contentLength = value.toIntOrNull() ?: 0
                }
            }

            when {
                method == "GET" && path == "/health" -> {
                    respond(output, 200, handler("__health__", JSONObject()))
                }
                method == "POST" && path == "/tool" -> {
                    if (contentLength <= 0 || contentLength > MAX_BODY_BYTES) {
                        return respond(output, 400, errorJson("bad_request", "invalid content-length: $contentLength"))
                    }
                    val body = ByteArray(contentLength)
                    var read = 0
                    while (read < contentLength) {
                        val n = input.read(body, read, contentLength - read)
                        if (n < 0) break
                        read += n
                    }
                    val json = runCatching { JSONObject(String(body, 0, read, Charsets.UTF_8)) }.getOrNull()
                        ?: return respond(output, 400, errorJson("bad_json", "request body is not valid JSON"))
                    val tool = json.optString("tool", "")
                    val args = json.optJSONObject("args") ?: JSONObject()
                    if (tool.isEmpty()) {
                        return respond(output, 400, errorJson("bad_request", "missing tool name"))
                    }
                    val result = runCatching { handler(tool, args) }.getOrElse {
                        errorJson("internal_error", it.message ?: it.javaClass.simpleName)
                    }
                    respond(output, 200, result)
                }
                else -> respond(output, 404, errorJson("not_found", "unknown path: $path"))
            }
        }
    }

    private fun readLine(input: BufferedInputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) break
            if (b != '\r'.code) sb.append(b.toChar())
            if (sb.length > 8192) return null
        }
        return sb.toString()
    }

    private fun respond(output: OutputStream, status: Int, body: JSONObject) {
        val statusText = when (status) {
            200 -> "OK"; 400 -> "Bad Request"; 404 -> "Not Found"; else -> "Error"
        }
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        val header = "HTTP/1.1 $status $statusText\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Connection: close\r\n\r\n"
        output.write(header.toByteArray(Charsets.UTF_8))
        output.write(bytes)
        output.flush()
    }

    private fun errorJson(code: String, message: String): JSONObject =
        JSONObject().put("ok", false).put(
            "error", JSONObject().put("code", code).put("message", message)
        )
}
