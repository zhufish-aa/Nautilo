package app.nautilo.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

val Ink = Color(0xFF181D24)
val Secondary = Color(0xFF526171)
val Blue = Color(0xFF327EA9)
val Selection = Color(0xFFDDEFFA)
val Line = Color(0xFFE6ECF1)
val Green = Color(0xFF379C6C)
val Danger = Color(0xFFAC4148)
val CodeFont = FontFamily(Font(app.nautilo.mobile.R.font.jetbrains_mono))
val Backdrop = Brush.verticalGradient(0f to Color(0xFFFBFCFE), 0.65f to Color(0xFFF7FAFD), 1f to Color(0xFFEFF7FE))
val UiTypography = Typography(
    bodyLarge = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 15.sp, lineHeight = 24.sp, color = Ink),
    bodyMedium = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 22.sp, color = Ink),
    titleLarge = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = Ink),
    titleMedium = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = Ink),
    labelLarge = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, fontWeight = FontWeight.Medium)
)
@Composable fun NautiloTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = lightColorScheme(primary = Blue, onPrimary = Color.White, secondary = Blue,
        background = Color(0xFFFAFCFE), surface = Color(0xFFFCFDFE), onSurface = Ink, onBackground = Ink,
        outline = Line, outlineVariant = Line, surfaceContainer = Color(0xFFF3F7FA)),
        shapes = Shapes(small = RoundedCornerShape(12.dp), medium = RoundedCornerShape(16.dp), large = RoundedCornerShape(22.dp), extraLarge = RoundedCornerShape(28.dp)),
        typography = UiTypography, content = content)
}
@Composable fun Dot(online: Boolean, modifier: Modifier = Modifier) {
    Box(modifier.size(6.dp).background(if (online) Green else Color(0xFF9AA5B0), CircleShape))
}
@Composable fun ActionIcon(icon: ImageVector, label: String, enabled: Boolean = true, click: () -> Unit) {
    IconButton(onClick = click, enabled = enabled) { Icon(icon, label, Modifier.size(21.dp), tint = if (enabled) Ink else Secondary.copy(alpha = 0.4f)) }
}
@Composable fun EmptyView(icon: ImageVector, title: String, detail: String? = null, action: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 30.dp, vertical = 44.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(13.dp)) {
        Icon(icon, null, Modifier.size(36.dp), tint = Blue.copy(alpha = 0.8f))
        Text(title, fontSize = 17.sp, fontWeight = FontWeight.Medium)
        detail?.let { Text(it, fontSize = 14.sp, color = Secondary, lineHeight = 23.sp) }
        action?.invoke()
    }
}
fun shortTime(value: String): String = runCatching {
    val time = Instant.parse(value).atZone(ZoneId.systemDefault())
    val today = java.time.LocalDate.now()
    when (time.toLocalDate()) {
        today -> time.format(DateTimeFormatter.ofPattern("HH:mm"))
        today.minusDays(1) -> "昨天"
        else -> time.format(DateTimeFormatter.ofPattern("M月d日"))
    }
}.getOrDefault("")
fun effortName(value: String) = when(value) {
    "off" -> "关闭"; "minimal" -> "最低"; "low" -> "低"; "medium" -> "中"; "high" -> "高"; "xhigh" -> "极高"; "max" -> "最高"; else -> value
}
