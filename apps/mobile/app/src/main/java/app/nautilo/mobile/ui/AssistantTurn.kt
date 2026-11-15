package app.nautilo.mobile.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.data.*

@Composable internal fun AssistantTurn(turn: ConversationItem.Turn, error: String = "") {
    val seenParts = remember(turn.id) { turn.parts.map { it.key }.toMutableSet() }
    val arrivals = if (turn.completed) emptySet() else turn.parts.map { it.key }.filterNot(seenParts::contains).toSet()
    SideEffect { seenParts.addAll(turn.parts.map { it.key }) }
    if (turn.run == null && turn.answer == null) {
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
            turn.parts.forEach { part -> key(part.key) { TurnPartView(part, part.key in arrivals) } }
        }
        return
    }
    // Same default and completion transition as desktop ConversationTurnView.
    var expanded by rememberSaveable(turn.id, turn.completed) { mutableStateOf(!turn.completed) }
    val process = turn.process
    val answer = turn.answer
    val active = !turn.completed
    val rotation by animateFloatAsState(if (expanded) 180f else 0f,
        tween(if (LocalNautiloMotion.current) 180 else 0, easing = MotionEase), label = "process-chevron")
    Column(Modifier.fillMaxWidth().padding(bottom = 18.dp)) {
        Row(Modifier.fillMaxWidth().clickable(enabled = process.isNotEmpty()) { expanded = !expanded }.heightIn(min = 32.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            turn.run?.let { RunStatusLabel(it) } ?: Text(if (active) "执行中" else "已完成", fontSize = 14.sp, color = Secondary)
            if (process.isNotEmpty()) {
                Icon(Icons.Outlined.ExpandMore, if (expanded) "收起执行过程" else "展开执行过程", Modifier.size(15.dp).rotate(rotation), tint = Secondary)
            }
        }
        NDivider(thickness = .5.dp, color = Line)
        Spacer(Modifier.height(14.dp))
        // Render the original sequence. Collapse process rows in place, exactly
        // as on PC; never move commentary, notices or the reply into new groups.
        turn.parts.forEach { part -> key(part.key) {
            if (part.visible(expanded, answer)) TurnPartView(part, part.key in arrivals)
        } }
        if (error.isNotBlank()) NPanel(color = Color(0xFFFFF5F4), shape = RoundedCornerShape(14.dp)) {
            Row(Modifier.padding(13.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Outlined.Info, null, Modifier.size(18.dp), tint = Danger)
                Text(error, color = Danger, fontSize = 13.sp, lineHeight = 21.sp)
            }
        }
    }
}

@Composable private fun TurnPartView(part: TurnPart, animate: Boolean = false) {
  MotionArrival(part.key, animate) {
    Column(Modifier.fillMaxWidth().testTag("turn-part:${part.key}")) {
        part.message?.let { Markdown(it.text, Modifier.padding(vertical = 7.dp)) }
        part.activity?.let {
            if (it.kind == "stopped") Text("已停止", Modifier.padding(vertical = 5.dp), fontSize = 13.sp, color = Secondary)
            else if (usesEventCard(it)) EventNotice(it) else ProcessActivity(it)
        }
    }
  }
}

@Composable private fun RunStatusLabel(run: RunInfo) {
    val active = running(run.status)
    val seconds = remember(run) { run.elapsedSeconds() }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (active) NSpinner(Modifier.size(10.dp), strokeWidth = 1.2.dp, color = Accent)
        Text(when (run.status) {
            "completed" -> "已完成"; "cancelled" -> "已停止"; "failed", "crashed", "timed_out" -> "未完成"
            else -> "执行中"
        } + if (active) "" else "，用时 " + durationLabel(seconds), fontSize = 14.sp, lineHeight = 20.sp, color = Secondary, maxLines = 1)
    }
}
private fun durationLabel(seconds: Long): String = when {
    seconds < 1 -> "不到1秒"
    seconds < 60 -> "${seconds}秒"
    seconds < 3600 -> "${seconds / 60}分" + if (seconds % 60 == 0L) "" else "${seconds % 60}秒"
    else -> "${seconds / 3600}小时" + if (seconds % 3600 / 60 == 0L) "" else "${seconds % 3600 / 60}分"
}
