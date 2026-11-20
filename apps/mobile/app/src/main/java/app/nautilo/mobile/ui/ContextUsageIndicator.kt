package app.nautilo.mobile.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Compress
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.data.ContextUsage
import app.nautilo.mobile.data.running
import app.nautilo.mobile.data.text
import java.text.NumberFormat
import java.util.Locale

internal fun tokenLabel(value: Long?): String {
    if (value == null) return "—"
    val format = NumberFormat.getNumberInstance(Locale.US).apply { maximumFractionDigits = 1 }
    return when {
        value >= 1_000_000 -> format.format(value / 1_000_000.0) + "M"
        value >= 100_000 -> format.format(value / 1_000.0) + "K"
        else -> format.format(value)
    }
}

@Composable internal fun ContextUsageIndicator(state: MobileState, onCompact: () -> Unit) {
    val session = state.session ?: return
    var open by remember(session.id) { mutableStateOf(false) }
    val usage = state.contextUsage.withModelWindow(state.models.find { it.text("id") == session.model.ifBlank { state.defaultModel } })
    val tone = when {
        (usage.percentage ?: 0f) >= 90 -> Danger
        (usage.percentage ?: 0f) >= 75 -> Color(0xFFAD701A)
        else -> Ink
    }
    val motion = LocalNautiloMotion.current
    val progress by animateFloatAsState(usage.percentage ?: 0f, tween(if (motion) 200 else 0), label = "context-usage")
    Box {
        NIconButton(onClick = { open = true }, modifier = Modifier.testTag("context-usage-indicator")
            .semantics { contentDescription = if (state.compacting) "上下文正在压缩" else
                "上下文：${tokenLabel(usage.used)} / ${usage.window?.let(::tokenLabel) ?: "上限未知"}" }) {
            if (state.compacting) NSpinner(Modifier.size(20.dp), strokeWidth = 2.dp)
            else Canvas(Modifier.size(20.dp)) {
                val stroke = Stroke(2.2.dp.toPx(), cap = StrokeCap.Round)
                val inset = stroke.width / 2
                val diameter = size.minDimension - stroke.width
                drawCircle(tone.copy(alpha = .16f), radius = diameter / 2, style = stroke)
                if (usage.percentage != null) {
                    if (progress > 0) drawArc(tone, -90f, 360 * progress / 100, false,
                        topLeft = Offset(inset, inset), size = Size(diameter, diameter), style = stroke)
                } else drawCircle(tone.copy(alpha = .65f), radius = 1.5.dp.toPx())
            }
        }
        NMenu(open, { open = false }) {
            ContextUsagePanel(usage, state.compacting, state.compactError,
                compactVisible = "session.compact" in state.capabilities && state.compactCommand.isNotBlank(),
                compactEnabled = state.connected && !state.readOnly && !state.busy && !running(state.runStatus) && state.canCompact,
                close = { open = false }, onCompact = onCompact)
        }
    }
}

@Composable internal fun ContextUsagePanel(usage: ContextUsage, compacting: Boolean = false, error: String = "",
    compactVisible: Boolean = false, compactEnabled: Boolean = false, close: () -> Unit = {}, onCompact: () -> Unit = {}) {
    Column(Modifier.width(280.dp).padding(horizontal = 15.dp).padding(top = 2.dp, bottom = 13.dp), verticalArrangement = Arrangement.spacedBy(17.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Layers, null, Modifier.size(17.dp), tint = Ink)
            Text("上下文", Modifier.weight(1f).padding(start = 8.dp), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = Ink)
            NIconButton(close, Modifier.size(36.dp)) { Icon(Icons.Outlined.Close, "关闭上下文", Modifier.size(18.dp)) }
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Text(tokenLabel(usage.used), fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold, color = Ink)
            Text("/ ${usage.window?.let(::tokenLabel) ?: "上限未知"}", Modifier.padding(bottom = 3.dp), fontSize = 14.sp, color = Ink)
        }
        usage.percentage?.let { percent ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Canvas(Modifier.weight(1f).height(4.dp)) {
                    val stroke = 4.dp.toPx()
                    drawLine(Line, Offset(0f, center.y), Offset(size.width, center.y), stroke, StrokeCap.Round)
                    if (percent > 0) drawLine(if (percent >= 90) Danger else Ink, Offset(0f, center.y), Offset(size.width * percent / 100, center.y), stroke, StrokeCap.Round)
                }
                Text("${kotlin.math.round(percent).toInt()}%", fontSize = 13.sp, color = Ink, fontWeight = FontWeight.Medium)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            UsageStat("可用空间", tokenLabel(usage.available))
            UsageStat("累计用量", tokenLabel(usage.totalTokens))
        }
        if (error.isNotBlank()) Text(error, fontSize = 13.sp, lineHeight = 21.sp, color = Danger)
        if (compactVisible) NButton(onCompact, Modifier.fillMaxWidth(), enabled = compactEnabled && !compacting) {
            if (compacting) NSpinner(Modifier.size(15.dp)) else Icon(Icons.Outlined.Compress, null, Modifier.size(16.dp))
            Spacer(Modifier.width(7.dp))
            Text(if (compacting) "正在压缩…" else "压缩上下文", fontSize = 14.sp)
        }
    }
}

@Composable private fun UsageStat(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), fontSize = 14.sp, color = Ink)
        Text(value, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = Ink)
    }
}
