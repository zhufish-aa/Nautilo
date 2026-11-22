package app.nautilo.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
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

internal data class MobileColors(
    val canvas: Color, val card: Color, val inset: Color, val sheet: Color, val group: Color,
    val ink: Color, val secondary: Color, val muted: Color, val divider: Color, val edge: Color,
    val accent: Color, val danger: Color, val dark: Boolean,
) {
    val primary = Color(0xFF2563EB)
    val pressed = Color(0xFF1D4ED8)
    val onPrimary = Color.White
    val green = Color(0xFF10B981)
    val mark = if (dark) green else Color(0xFF047857)
    val amber = if (dark) Color(0xFFF59E0B) else Color(0xFF9A5805)
    val tint = accent.copy(alpha = if (dark) .13f else .085f)
    val chrome = canvas.copy(alpha = if (dark) .78f else .82f)
    val floating = (if (dark) sheet else card).copy(alpha = if (dark) .84f else .90f)
    val veil = Color.Black.copy(alpha = if (dark) .58f else .34f)
    val highlight = if (dark) Color.White.copy(alpha = .05f) else Color.Transparent
    val dot = if (dark) Color.White.copy(alpha = .06f) else Color(0xFF0F172A).copy(alpha = .07f)
}

internal val LightMobileColors = MobileColors(
    Color(0xFFF4F5F8), Color.White, Color(0xFFECEFF4), Color.White, Color(0xFFF4F5F8),
    Color(0xFF0F172A), Color(0xFF526176), Color(0xFF64748B), Color(0x0F0F172A), Color(0x1A0F172A),
    Color(0xFF2563EB), Color(0xFFAE3843), dark = false,
)
private val DarkMobileColors = MobileColors(
    Color(0xFF090B0E), Color(0xFF11141B), Color(0xFF0C0E13), Color(0xFF141821), Color(0xFF181C26),
    Color(0xFFF8FAFC), Color(0xFF94A3B8), Color(0xFF64748B), Color(0x12FFFFFF), Color(0x1AFFFFFF),
    Color(0xFF3B82F6), Color(0xFFF87171), dark = true,
)
private val LocalMobileColors = staticCompositionLocalOf { LightMobileColors }
internal val MobilePalette: MobileColors @Composable get() = LocalMobileColors.current
val Ink: Color @Composable get() = MobilePalette.ink
val Secondary: Color @Composable get() = MobilePalette.secondary
val Accent: Color @Composable get() = MobilePalette.accent
val Selection: Color @Composable get() = MobilePalette.tint
val Line: Color @Composable get() = MobilePalette.divider
val Green: Color @Composable get() = MobilePalette.mark
val Danger: Color @Composable get() = MobilePalette.danger
@OptIn(ExperimentalTextApi::class)
val UiFont = FontFamily(*listOf(400, 500, 600, 700).map { weight ->
    Font(app.nautilo.mobile.R.font.noto_sans_sc, weight = FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
}.toTypedArray())
@OptIn(ExperimentalTextApi::class)
val CodeFont = FontFamily(Font(app.nautilo.mobile.R.font.jetbrains_mono, variationSettings = FontVariation.Settings(FontVariation.weight(400))))
val Backdrop: SolidColor @Composable get() = SolidColor(MobilePalette.canvas)
val UiTypography = Typography(
    bodyLarge = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 17.sp, lineHeight = 28.sp),
    bodyMedium = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 16.sp, lineHeight = 26.sp),
    bodySmall = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 14.sp, lineHeight = 22.sp),
    titleLarge = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 21.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 17.sp, fontWeight = FontWeight.Medium),
    titleSmall = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 16.sp, fontWeight = FontWeight.Medium),
    labelLarge = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 15.sp, fontWeight = FontWeight.Medium),
    labelMedium = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 13.sp, fontWeight = FontWeight.Medium),
    labelSmall = androidx.compose.ui.text.TextStyle(fontFamily = UiFont, fontSize = 12.sp)
)
@Composable fun NautiloTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) DarkMobileColors else LightMobileColors
    val scheme = (if (colors.dark) darkColorScheme() else lightColorScheme()).copy(
        primary = colors.primary, onPrimary = colors.onPrimary, secondary = colors.secondary,
        primaryContainer = colors.tint, onPrimaryContainer = colors.ink, secondaryContainer = colors.group, onSecondaryContainer = colors.ink,
        tertiary = colors.accent, onTertiary = colors.onPrimary, error = colors.danger,
        background = colors.canvas, surface = colors.card, onSurface = colors.ink, onBackground = colors.ink,
        surfaceVariant = colors.inset, onSurfaceVariant = colors.secondary, surfaceTint = Color.Transparent,
        outline = colors.edge, outlineVariant = colors.divider,
        surfaceContainer = colors.sheet, surfaceContainerLow = colors.card, surfaceContainerHigh = colors.group,
    )
    ProvideNautiloMotion {
        CompositionLocalProvider(LocalMobileColors provides colors, LocalContentColor provides colors.ink) {
            MaterialTheme(colorScheme = scheme,
                shapes = Shapes(small = RoundedCornerShape(12.dp), medium = RoundedCornerShape(16.dp), large = RoundedCornerShape(22.dp), extraLarge = RoundedCornerShape(28.dp)),
                typography = UiTypography, content = content)
        }
    }
}
@Composable fun Dot(online: Boolean, modifier: Modifier = Modifier) {
    Box(modifier.size(6.dp).background(if (online) MobilePalette.green else MobilePalette.muted, CircleShape))
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
