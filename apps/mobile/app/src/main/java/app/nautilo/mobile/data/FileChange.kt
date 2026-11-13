package app.nautilo.mobile.data

import com.github.difflib.DiffUtils
import com.github.difflib.UnifiedDiffUtils
import org.json.JSONObject

enum class DiffKind { Context, Added, Removed, Hunk, Note }
data class DiffLine(val kind: DiffKind, val text: String, val oldNumber: Int? = null, val newNumber: Int? = null)
data class FileChange(val path: String, val lines: List<DiffLine>, val verifiedDiff: Boolean, val truncated: Boolean) {
    val name get() = path.replace('\\', '/').substringAfterLast('/')
    val folder get() = path.replace('\\', '/').substringBeforeLast('/', "")
    val added get() = lines.count { it.kind == DiffKind.Added }
    val removed get() = lines.count { it.kind == DiffKind.Removed }
    companion object {
        fun decode(file: JSONObject): FileChange {
            var patch = file.text("patch")
            val before = file.text("before")
            val after = file.text("after")
            val beforeKnown = file.has("before") && !file.isNull("before") || file.text("changeType") == "added"
            val afterKnown = file.has("after") && !file.isNull("after") || file.text("changeType") == "deleted"
            val path = file.text("path")
            if (patch.isBlank() && beforeKnown && afterKnown) {
                val oldLines = sourceLines(before)
                patch = UnifiedDiffUtils.generateUnifiedDiff("a/$path", "b/$path", oldLines, DiffUtils.diff(oldLines, sourceLines(after)), 5).joinToString("\n")
            }
            val parsed = parseUnifiedDiff(patch)
            val verified = patch.isNotBlank() || beforeKnown && afterKnown
            val lines = if (verified) parsed else sourceLines(after.ifEmpty { before }).mapIndexed { i, text -> DiffLine(DiffKind.Context, text, newNumber = i + 1) }
            return FileChange(path, lines, verified, file.optBoolean("truncated"))
        }
    }
}
private fun sourceLines(text: String): List<String> = if (text.isEmpty()) emptyList() else text.replace("\r\n", "\n").split('\n').let { if (it.last().isEmpty()) it.dropLast(1) else it }

/** Hunk coordinates provide real old/new line numbers, including zero-length insertions. */
fun parseUnifiedDiff(patch: String): List<DiffLine> {
    val lines = mutableListOf<DiffLine>()
    var old = 0
    var new = 0
    var inHunk = false
    val hunk = Regex("^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@(.*)$")
    patch.lineSequence().forEach { line ->
        val match = hunk.matchEntire(line)
        if (match != null) {
            old = match.groupValues[1].toInt(); new = match.groupValues[2].toInt(); inHunk = true
            lines += DiffLine(DiffKind.Hunk, line)
        } else if (inHunk) when {
            line.startsWith(' ') -> lines += DiffLine(DiffKind.Context, line.drop(1), old++, new++)
            line.startsWith('+') -> lines += DiffLine(DiffKind.Added, line.drop(1), null, new++)
            line.startsWith('-') -> lines += DiffLine(DiffKind.Removed, line.drop(1), old++, null)
            line.startsWith('\\') -> lines += DiffLine(DiffKind.Note, line)
        }
    }
    return lines
}
