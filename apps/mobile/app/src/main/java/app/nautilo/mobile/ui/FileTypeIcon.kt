package app.nautilo.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable internal fun FileTypeIcon(path: String, large: Boolean = false) {
    val (label, color) = when (path.substringAfterLast('.').lowercase()) {
        "ts" -> "TS" to Color(0xFF2874BB)
        "tsx", "jsx" -> "⚛" to Color(0xFF12839A)
        "js", "mjs", "cjs" -> "JS" to Color(0xFF987308)
        "dart" -> "D" to Color(0xFF187FAB)
        "rs" -> "Rs" to Color(0xFF875E45)
        "py" -> "Py" to Color(0xFF4379A1)
        "kt", "kts" -> "Kt" to Color(0xFF5266B7)
        "json" -> "{ }" to Color(0xFF947326)
        "css", "scss" -> "#" to Color(0xFF377BAA)
        "html", "xml", "svg" -> "</>" to Color(0xFFC46B48)
        "md", "txt" -> "M↓" to Color(0xFF586D82)
        "sh", "ps1", "bat", "cmd" -> ">_" to Color(0xFF4F7079)
        else -> "↗" to Secondary
    }
    Box(Modifier.size(if (large) 44.dp else 33.dp).background(color.copy(alpha = .09f), RoundedCornerShape(if (large) 13.dp else 10.dp)), contentAlignment = Alignment.Center) {
        Text(label, color = color, fontSize = if (large) 14.sp else 11.sp, fontWeight = FontWeight.SemiBold)
    }
}
