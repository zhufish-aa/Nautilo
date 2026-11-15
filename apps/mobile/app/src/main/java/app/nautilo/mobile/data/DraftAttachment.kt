package app.nautilo.mobile.data

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID

data class DraftAttachment(val id: String, val name: String, val mimeType: String, val sizeBytes: Long, val path: String) {
    fun encode() = json("id" to id, "name" to name, "mimeType" to mimeType, "sizeBytes" to sizeBytes, "path" to path)
    companion object {
        const val MAX_BYTES = 20L * 1024 * 1024
        const val MAX_FILES = 10
        fun decode(v: JSONObject) = DraftAttachment(v.getString("id"), v.getString("name"), v.getString("mimeType"), v.getLong("sizeBytes"), v.getString("path"))
    }
}

/** Copy provider URIs into private storage so reconnects never depend on a temporary grant. */
class AttachmentFiles(private val context: Context) {
    private val root = File(context.filesDir, "message-attachments")
    fun import(uri: Uri): DraftAttachment {
        val resolver = context.contentResolver
        var name = "附件"
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val size = cursor.getColumnIndex(OpenableColumns.SIZE)
                require(size < 0 || cursor.isNull(size) || cursor.getLong(size) <= DraftAttachment.MAX_BYTES) { "每个附件最多 20 MB" }
                val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (column >= 0) name = cursor.getString(column).orEmpty().ifBlank { "附件" }
            }
        }
        name = name.substringAfterLast('/').substringAfterLast('\\').filterNot(Char::isISOControl).take(120).ifBlank { "附件" }
        val id = UUID.randomUUID().toString()
        root.mkdirs()
        val target = File(root, id)
        try {
            val size = requireNotNull(resolver.openInputStream(uri)) { "无法读取所选文件" }.use { input ->
                target.outputStream().use { copyAttachment(input, it, DraftAttachment.MAX_BYTES) }
            }
            val mime = resolver.getType(uri).orEmpty().takeUnless { it.isBlank() || it == "application/octet-stream" }
                ?: imageMime(name).ifBlank { "application/octet-stream" }
            return DraftAttachment(id, name, mime, size, target.absolutePath)
        } catch (error: Exception) { target.delete(); throw error }
    }
    fun file(attachment: DraftAttachment): File {
        val target = File(attachment.path).canonicalFile
        require(target.parentFile == root.canonicalFile && target.name == attachment.id && target.isFile && target.length() == attachment.sizeBytes) { "附件已不可用，请重新选择" }
        return target
    }
    fun remove(attachment: DraftAttachment) { runCatching { file(attachment).delete() } }
}

internal fun copyAttachment(input: InputStream, output: OutputStream, limit: Long): Long {
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
        val count = input.read(buffer)
        if (count < 0) return total
        total += count
        require(total <= limit) { "每个附件最多 20 MB" }
        output.write(buffer, 0, count)
    }
}
