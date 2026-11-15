package app.nautilo.mobile.data

import java.net.URLDecoder

data class FileReference(val path: String, val line: Int? = null)
data class RemoteFilePreview(
    val path: String = "", val mimeType: String = "", val size: Long = 0,
    val modifiedAt: String = "", val bytes: ByteArray = byteArrayOf(),
    val nextOffset: Int? = null, val candidates: List<String> = emptyList(),
    val loading: Boolean = false, val error: String = "", val line: Int? = null,
)

/** Files stay on the selected computer; href parsing never launches local OS paths. */
fun fileReference(href: String, allowUnknown: Boolean = false): FileReference? {
    var value = href.trim()
    if (value.isEmpty() || value.startsWith('#')) return null
    if (value.startsWith("?agenthub-local-path=")) value = value.removePrefix("?agenthub-local-path=")
    if (Regex("^[A-Za-z][A-Za-z0-9+.-]*:").containsMatchIn(value)
        && !Regex("^[A-Za-z]:[/\\\\]").containsMatchIn(value) && !value.startsWith("file:", true)
        && !value.startsWith("nautilo-local:")) return null
    val fileUrl = value.startsWith("file://", true)
    value = value.removePrefix("nautilo-local:").replace(Regex("^file://", RegexOption.IGNORE_CASE), "")
    if (fileUrl && !value.startsWith('/') && !Regex("^[A-Za-z]:[/\\\\]").containsMatchIn(value)) value = "//$value"
    value = runCatching { URLDecoder.decode(value.replace("+", "%2B"), "UTF-8") }.getOrDefault(value)
    value = value.replace(Regex("^/(?=[A-Za-z]:[/\\\\])"), "")
    if (Regex("^[A-Za-z][A-Za-z0-9+.-]*:").containsMatchIn(value) && !Regex("^[A-Za-z]:[/\\\\]").containsMatchIn(value)) return null
    val suffix = Regex("(?:#L(\\d+)(?:C\\d+)?(?:-L?\\d+(?:C\\d+)?)?|:(\\d+)(?::\\d+)?)$").find(value)
    val line = suffix?.let { it.groupValues[1].ifEmpty { it.groupValues[2] }.toIntOrNull() }
    if (suffix != null) value = value.substring(0, suffix.range.first)
    else value = value.substringBefore('#')
    if (value.isBlank() || value.contains('\u0000') || value.length > 4096) return null
    val namedFile = value.lowercase() in setOf(".gitignore", ".env", ".npmrc", ".dockerignore", ".editorconfig", "dockerfile", "makefile", "license")
    if (!allowUnknown && !namedFile && !value.contains('/') && !value.contains('\\') && !Regex("(?i)\\.(rs|tsx?|jsx?|[cm]?ts|[cm]?js|json|md|txt|py|kt|kts|java|go|c|h|cpp|hpp|cs|sh|ps1|ya?ml|toml|xml|html?|css|sql|log|lock|csv|svg|png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?)$").containsMatchIn(value)) return null
    return FileReference(value, line?.takeIf { it > 0 })
}

fun RemoteFilePreview.isBinaryPreview() = mimeType.startsWith("image/") || mimeType == "application/pdf"

internal fun normalizeMarkdownFileLinks(source: String): String =
    Regex("(\\[[^\\]\\r\\n]+\\])\\(\\s*(<[^>\\r\\n]+>|[^)\\r\\n]+?)\\s*\\)").replace(source) { match ->
        val raw = match.groupValues[2].trim().removeSurrounding("<", ">")
        if (Regex("^[A-Za-z]:[/\\\\]").containsMatchIn(raw) || raw.startsWith("\\\\"))
            "${match.groupValues[1]}(?agenthub-local-path=${java.net.URLEncoder.encode(raw, "UTF-8").replace("+", "%20")})"
        else match.value
    }
