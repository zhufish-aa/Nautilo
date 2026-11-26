package app.nautilo.mobile.data

/** Keep incomplete Markdown together. Only cut at a blank line followed by a
 * complete top-level line that cannot continue the preceding block. */
internal class StreamingMarkdownBoundary {
    private var offset = 0
    private var fence = ""
    private var blank = false
    private val fenceStart = Regex("""^ {0,3}(""" + "\u0060{3,}|~{3,}" + """)(.*)$""")
    private val continuation = Regex("""^(?:\s|[>|<]|\[.*]:|[-+*](?:\s|$)|\d+[.)](?:\s|$)|=+|-+)""")
    var end: Int = 0
        private set

    fun append(text: String) {
        while (offset < text.length) {
            val newline = text.indexOf('\n', offset)
            if (newline < 0) break
            val line = text.substring(offset, newline).trimEnd('\r')
            val marker = fenceStart.matchEntire(line)
            if (fence.isNotEmpty()) {
                val run = marker?.groupValues?.get(1).orEmpty()
                if (run.startsWith(fence) && marker?.groupValues?.get(2).isNullOrBlank()) fence = ""
            } else if (line.isBlank()) {
                blank = true
            } else {
                if (blank && !continuation.containsMatchIn(line)) end = offset
                blank = false
                if (marker != null) fence = marker.groupValues[1]
            }
            offset = newline + 1
        }
    }
}
