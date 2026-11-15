package app.nautilo.mobile.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.Base64

data class ChatAttachment(
    val id: String, val name: String, val mimeType: String = "", val sizeBytes: Long = 0,
    val kind: String = "file", val uploadId: String = "", val localPath: String = "",
) {
    val isImage get() = kind == "image" || mimeType.startsWith("image/") || imageMime(name).isNotEmpty()
    val cacheId get() = uploadId.ifBlank { id }
    companion object {
        fun decode(value: JSONObject) = ChatAttachment(value.text("id"), value.text("name", "附件"), value.text("mimeType"),
            value.optLong("sizeBytes"), value.text("kind", "file"), value.text("uploadId"))
        fun draft(file: DraftAttachment) = ChatAttachment(file.id, file.name, file.mimeType, file.sizeBytes,
            if (file.mimeType.startsWith("image/")) "image" else "file", file.id, file.path)
    }
}

internal fun imageMime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "webp" -> "image/webp"
    "gif" -> "image/gif"; "bmp" -> "image/bmp"; "avif" -> "image/avif"
    "heic" -> "image/heic"; "heif" -> "image/heif"; else -> ""
}

/** An evictable image cache, separate from durable pending uploads. No desktop paths are accepted. */
class AttachmentImages(private val root: File) {
    private val downloads = Mutex()
    private fun target(host: String, session: String, attachment: ChatAttachment): File {
        val key = "$host\u0000$session\u0000${attachment.cacheId}"
        val name = MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(root, "$name.image")
    }
    suspend fun retain(host: String, session: String, file: DraftAttachment) = withContext(Dispatchers.IO) {
        if (!ChatAttachment.draft(file).isImage) return@withContext
        downloads.withLock {
            root.mkdirs()
            val target = target(host, session, ChatAttachment.draft(file))
            if ((!target.isFile || target.length() != file.sizeBytes) && File(file.path).isFile) {
                val temporary = File(root, "${target.name}.part")
                try {
                    File(file.path).copyTo(temporary, overwrite = true)
                    target.delete()
                    require(temporary.renameTo(target)) { "无法缓存图片，请检查手机存储空间" }
                } finally { temporary.delete() }
            }
            trim(target)
        }
    }
    suspend fun load(host: String, session: String, attachment: ChatAttachment, read: suspend (JSONObject) -> JSONObject): File = withContext(Dispatchers.IO) {
        if (attachment.localPath.isNotBlank()) File(attachment.localPath).takeIf { it.isFile }?.let { return@withContext it }
        downloads.withLock {
            root.mkdirs()
            val target = target(host, session, attachment)
            if (target.isFile && (attachment.sizeBytes == 0L || target.length() == attachment.sizeBytes)) {
                target.setLastModified(System.currentTimeMillis()); return@withLock target
            }
            require(attachment.localPath.isEmpty()) { "本地图片暂不可用，请同步消息后重试" }
            target.delete()
            val temporary = File(root, "${target.name}.part")
            try {
                var offset = 0L
                var size = -1L
                var version = ""
                temporary.outputStream().use { output ->
                    do {
                        val chunk = read(json("sessionId" to session, "attachmentId" to attachment.id, "offset" to offset))
                        val total = chunk.getLong("size")
                        require(total in 1..DraftAttachment.MAX_BYTES && chunk.getLong("offset") == offset) { "图片数据无效" }
                        if (size < 0) { size = total; version = chunk.text("modifiedAt") }
                        require(size == total && version == chunk.text("modifiedAt")) { "图片已改变，请刷新后重试" }
                        val bytes = Base64.getDecoder().decode(chunk.getString("base64"))
                        require(bytes.isNotEmpty() && bytes.size <= 512 * 1024 && offset + bytes.size <= size) { "图片数据不完整" }
                        output.write(bytes); offset += bytes.size
                        if (offset < size) {
                            require(!chunk.isNull("nextOffset") && chunk.getLong("nextOffset") == offset) { "图片数据不完整" }
                            delay(150) // Share the RPC budget with journal and presence traffic.
                        }
                    } while (offset < size)
                }
                require(temporary.renameTo(target)) { "无法缓存图片，请检查手机存储空间" }
                trim(target); target
            } finally { temporary.delete() }
        }
    }
    private fun trim(keep: File) {
        val files = root.listFiles()?.filter { it.extension == "image" }?.sortedBy { it.lastModified() }.orEmpty()
        var size = files.sumOf { it.length() }
        for (file in files) if (size > 96L * 1024 * 1024 && file != keep) {
            val bytes = file.length(); if (file.delete()) size -= bytes
        }
    }
}
