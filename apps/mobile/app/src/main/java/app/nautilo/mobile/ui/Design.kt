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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

val Ink = Color(0xFF222222)
val Secondary = Color(0xFF737373)
val Accent = Ink
val Selection = Color(0xFFF3F3F3)
val Line = Color(0xFFE8E8E8)
val Green = Color(0xFF379C6C)
val Danger = Color(0xFFAC4148)
@OptIn(ExperimentalTextApi::class)
val UiFont = FontFamily(*listOf(400, 500, 600, 700).map { weight ->
    Font(app.nautilo.mobile.R.font.noto_sans_sc, weight = FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
}.toTypedArray())
@OptIn(ExperimentalTextApi::class)
val CodeFont = FontFamily(Font(app.nautilo.mobile.R.font.jetbrains_mono, variationSettings = FontVariation.Settings(FontVariation.weight(400))))
val Backdrop = SolidColor(Color.White)
val UiTypography = Typography(
    bodyLarge = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 17.sp, lineHeight = 28.sp, color = Ink),
    bodyMedium = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 16.sp, lineHeight = 26.sp, color = Ink),
    bodySmall = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 14.sp, lineHeight = 22.sp, color = Secondary),
    titleLarge = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 21.sp, fontWeight = FontWeight.SemiBold, color = Ink),
    titleMedium = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 17.sp, fontWeight = FontWeight.Medium, color = Ink),
    titleSmall = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = Ink),
    labelLarge = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 15.sp, fontWeight = FontWeight.Medium),
    labelMedium = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 13.sp, fontWeight = FontWeight.Medium),
    labelSmall = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 12.sp)
)
@Composable fun NautiloTheme(content: @Composable () -> Unit) {
    ProvideNautiloMotion {
    MaterialTheme(colorScheme = lightColorScheme(primary = Ink, onPrimary = Color.White, secondary = Ink,
        primaryContainer = Selection, onPrimaryContainer = Ink, secondaryContainer = Selection, onSecondaryContainer = Ink,
        tertiary = Ink, tertiaryContainer = Selection, onTertiaryContainer = Ink,
        background = Color.White, surface = Color.White, onSurface = Ink, onBackground = Ink,
        surfaceVariant = Selection, onSurfaceVariant = Secondary, surfaceTint = Color.Transparent,
        outline = Line, outlineVariant = Line, surfaceContainer = Color(0xFFFAFAFA),
        surfaceContainerLow = Color(0xFFFAFAFA), surfaceContainerHigh = Selection, surfaceContainerHighest = Selection),
        shapes = Shapes(small = RoundedCornerShape(12.dp), medium = RoundedCornerShape(16.dp), large = RoundedCornerShape(22.dp), extraLarge = RoundedCornerShape(28.dp)),
        typography = UiTypography, content = content)
    }
}
@Composable fun Dot(online: Boolean, modifier: Modifier = Modifier) {
    Box(modifier.size(6.dp).background(if (online) Green else Color(0xFF999999), CircleShape))
}
@Composable fun ActionIcon(icon: ImageVector, label: String, enabled: Boolean = true, click: () -> Unit) {
    NIconButton(onClick = click, enabled = enabled) { Icon(icon, label, Modifier.size(21.dp), tint = if (enabled) Ink else Secondary.copy(alpha = 0.4f)) }
}
@Composable fun EmptyView(icon: ImageVector, title: String, detail: String? = null, action: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 30.dp, vertical = 44.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(13.dp)) {
        Icon(icon, null, Modifier.size(36.dp), tint = Accent.copy(alpha = 0.8f))
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
