package app.nautilo.mobile.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import dev.snipme.highlights.Highlights
import dev.snipme.highlights.model.ColorHighlight
import dev.snipme.highlights.model.SyntaxLanguage
import dev.snipme.highlights.model.SyntaxThemes

/** Parse a whole side once, preserving multi-line syntax rather than highlighting each row independently. */
internal fun highlightCode(code: String, path: String): AnnotatedString {
    val language = when (path.substringAfterLast('.').lowercase()) {
        "js", "mjs", "cjs", "jsx", "json" -> SyntaxLanguage.JAVASCRIPT
        "ts", "tsx" -> SyntaxLanguage.TYPESCRIPT
        "kt", "kts" -> SyntaxLanguage.KOTLIN
        "py" -> SyntaxLanguage.PYTHON
        "dart" -> SyntaxLanguage.DART
        "rs" -> SyntaxLanguage.RUST
        "java" -> SyntaxLanguage.JAVA
        "go" -> SyntaxLanguage.GO
        "sh", "ps1", "cmd", "bat" -> SyntaxLanguage.SHELL
        "c", "h" -> SyntaxLanguage.C
        "cpp", "hpp" -> SyntaxLanguage.CPP
        "swift" -> SyntaxLanguage.SWIFT
        else -> SyntaxLanguage.DEFAULT
    }
    val builder = AnnotatedString.Builder(code)
    val theme = SyntaxThemes.atom().copy(code = 0x242424, keyword = 0x81559B, string = 0x52774B, literal = 0x9A6138, comment = 0x8A8A8A, multilineComment = 0x8A8A8A, punctuation = 0x575757, mark = 0x575757)
    val tokens = Highlights.Builder().code(code).language(language).theme(theme).build().getHighlights()
    tokens.filterIsInstance<ColorHighlight>().forEach { token ->
        val start = token.location.start.coerceIn(0, code.length)
        val end = token.location.end.coerceIn(start, code.length)
        if (end > start) builder.addStyle(SpanStyle(color = Color(token.rgb or (0xFF shl 24))), start, end)
    }
    return builder.toAnnotatedString()
}
