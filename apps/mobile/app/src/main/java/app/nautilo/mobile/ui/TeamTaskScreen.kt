package app.nautilo.mobile.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.Screen
import app.nautilo.mobile.data.*
import kotlinx.coroutines.delay
import java.time.Duration
import java.time.Instant

internal val TeamCanvas: Color @Composable get() = MobilePalette.canvas
internal val TeamText: Color @Composable get() = Ink
internal val TeamSecondary: Color @Composable get() = Secondary
internal val TeamLine: Color @Composable get() = Line

@Composable fun TeamTaskScreen(state: MobileState, model: MobileViewModel) = TeamTaskContent(
    state.teamTasks, state.session?.title.orEmpty(), state.teamTasksLoading, state.teamTasksError, state.teamTasksCancelling,
    back = { model.navigate(Screen.Chat) }, refresh = model::refreshTeamTasks, stop = model::cancelTeamTasks, open = model::openTeamTask,
    retry = if ("session.team.retry" in state.capabilities) model::retryTeamTask else null)

/** Geometry follows the approved 393 dp portrait: 16 dp gutter, shared rail and fixed actions. */
@Composable internal fun TeamTaskContent(snapshot: TeamTaskSnapshot, sessionTitle: String, loading: Boolean = false,
    error: String = "", cancelling: Boolean = false, back: () -> Unit, refresh: () -> Unit, stop: () -> Unit, open: (TeamTask) -> Unit,
    retry: ((TeamTask) -> Unit)? = null) {
    var tab by rememberSaveable(snapshot.sessionId) { mutableIntStateOf(0) }
    var showTodos by rememberSaveable(snapshot.sessionId) { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().background(TeamCanvas).testTag("team-task-page")) {
        TeamTaskHeader(snapshot, sessionTitle, tab, { tab = it })
        if (loading && snapshot.team == null) NProgress(Modifier.fillMaxWidth())
        if (error.isNotEmpty()) Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(error, color = Danger, fontSize = 12.sp, lineHeight = 19.sp, modifier = Modifier.weight(1f))
            ActionIcon(Icons.Outlined.Refresh, "重试团队任务", !loading, refresh)
        }
        if (snapshot.workflowTodos.isNotEmpty()) TextButton(
            modifier = Modifier.padding(horizontal = 12.dp),
            onClick = { showTodos = true }
        ) { Text("工作流待处理 · ${snapshot.workflowTodos.size}") }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (tab == 0) TeamTaskTimeline(snapshot, open, retry)
            else TeamMembers(snapshot)
        }
        TeamTaskFooter(snapshot, cancelling, back, stop) { tab = 1 }
    }
    if (showTodos) AlertDialog(
        onDismissRequest = { showTodos = false },
        title = { Text("工作流待处理") },
        text = {
            LazyColumn(Modifier.heightIn(max = 340.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(snapshot.workflowTodos, key = { it.id }) { todo ->
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(todo.title, color = TeamText, fontWeight = FontWeight.Medium)
                        Text(when (todo.kind) {
                            "delegate" -> "等待批准派发"
                            "merge" -> "等待在电脑端检查并合入"
                            "verification" -> "等待批准验收命令"
                            "recovery" -> "需要在电脑端核对执行结果"
                            else -> "需要决定如何继续"
                        }, color = TeamSecondary, fontSize = 13.sp)
                        if (todo.detail.isNotBlank()) Text(todo.detail, color = TeamSecondary, fontSize = 12.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { showTodos = false; back() }) { Text("返回会话") } },
        dismissButton = { TextButton(onClick = { showTodos = false }) { Text("关闭") } }
    )
}

@Composable private fun TeamTaskHeader(snapshot: TeamTaskSnapshot, sessionTitle: String, tab: Int, choose: (Int) -> Unit) {
    val title = snapshot.goal.ifBlank { sessionTitle.ifBlank { snapshot.team?.name ?: "团队任务" } }
    Column(Modifier.padding(horizontal = 16.dp).padding(top = 13.dp)) {
        Text("${snapshot.project.ifBlank { "Nautilo" }} / 工作区", color = TeamSecondary, fontSize = 13.sp, lineHeight = 20.sp)
        Row(Modifier.fillMaxWidth().padding(top = 11.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, fontSize = 23.sp, lineHeight = 31.sp, fontWeight = FontWeight.SemiBold, color = TeamText,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (snapshot.runId.isNotEmpty()) TeamStatusBadge(snapshot.status)
        }
        NPanel(onClick = { choose(1) }, color = Color.Transparent, shape = RoundedCornerShape(10.dp)) {
            Row(Modifier.heightIn(min = 46.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(snapshot.team?.name ?: "协作团队", fontSize = 15.sp, fontWeight = FontWeight.Medium, color = TeamText)
                Row(Modifier.padding(start = 9.dp), horizontalArrangement = Arrangement.spacedBy((-7).dp)) {
                    snapshot.members.take(3).forEach { TeamMemberAvatar(it) }
                }
                Icon(Icons.Outlined.ChevronRight, null, Modifier.padding(start = 7.dp).size(18.dp), tint = TeamText)
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("${snapshot.completed} / ${snapshot.tasks.size} 已完成", fontSize = 14.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium, color = TeamText)
            Spacer(Modifier.weight(1f))
            TeamElapsed(snapshot)
        }
        val progress by animateFloatAsState(if (snapshot.tasks.isEmpty()) 0f else snapshot.completed.toFloat() / snapshot.tasks.size,
            tween(if (LocalNautiloMotion.current) 260 else 0), label = "team-progress")
        Box(Modifier.fillMaxWidth().padding(top = 9.dp).height(8.dp).clip(CircleShape).background(MobilePalette.inset)) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(progress.coerceIn(0f, 1f)).background(TeamText, CircleShape))
        }
        Row(Modifier.fillMaxWidth().padding(top = 12.dp).height(43.dp), verticalAlignment = Alignment.Bottom) {
            listOf("任务 ${snapshot.tasks.size}", "成员 ${snapshot.members.size}").forEachIndexed { index, label ->
                NPanel(onClick = { choose(index) }, color = Color.Transparent, shape = RoundedCornerShape(8.dp), modifier = Modifier.width(80.dp).fillMaxHeight()) {
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.SpaceBetween) {
                        Text(label, fontSize = 16.sp, lineHeight = 23.sp, fontWeight = if (index == tab) FontWeight.SemiBold else FontWeight.Medium,
                            color = if (index == tab) TeamText else TeamSecondary, modifier = Modifier.padding(top = 5.dp, start = 2.dp))
                        Box(Modifier.width(49.dp).height(2.5.dp).background(if (index == tab) TeamText else Color.Transparent, CircleShape))
                    }
                }
            }
        }
        HorizontalDivider(thickness = .5.dp, color = TeamLine)
    }
}

@Composable private fun TeamElapsed(snapshot: TeamTaskSnapshot) {
    var now by remember(snapshot.runId) { mutableStateOf(Instant.now()) }
    LaunchedEffect(snapshot.runId, snapshot.active) {
        while (snapshot.active) { now = Instant.now(); delay(1_000) }
    }
    val seconds = runCatching { Duration.between(Instant.parse(snapshot.startedAt),
        snapshot.endedAt.takeIf(String::isNotBlank)?.let(Instant::parse) ?: now).seconds.coerceAtLeast(0) }.getOrNull()
    if (seconds != null) Text((if (snapshot.active) "已运行 " else "用时 ") + when {
        seconds >= 3600 -> "${seconds / 3600}小时${seconds % 3600 / 60}分"
        seconds >= 60 -> "${seconds / 60}分${seconds % 60}秒"; else -> "${seconds}秒"
    }, fontSize = 12.sp, color = TeamSecondary, maxLines = 1)
}

@Composable internal fun TeamStatusBadge(status: String) {
    val label = when (status) {
        "executing", "initializing", "planning", "running", "verifying", "merging" -> "运行中"
        "waiting_user" -> "待回答"; "waiting_approval" -> "待批准"; "paused" -> "已暂停"
        "completed" -> "已完成"; "failed" -> "失败"; "cancelled" -> "已停止"; else -> "待执行"
    }
    NPanel(shape = RoundedCornerShape(8.dp), border = BorderStroke(.75.dp, TeamText), color = TeamCanvas) {
            Row(Modifier.padding(horizontal = 9.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(6.dp).background(if (status == "failed") Danger else if (label in listOf("运行中", "已完成")) Green else TeamSecondary, CircleShape))
                Text(label, fontSize = 12.sp, lineHeight = 17.sp, fontWeight = FontWeight.Medium, color = TeamText)
            }
    }
}

@Composable private fun TeamTaskFooter(snapshot: TeamTaskSnapshot, cancelling: Boolean, back: () -> Unit, stop: () -> Unit, members: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(TeamCanvas).padding(horizontal = 16.dp).padding(bottom = 8.dp)) {
        HorizontalDivider(thickness = .5.dp, color = TeamLine)
        if (snapshot.members.isNotEmpty()) LazyRow(Modifier.fillMaxWidth().height(44.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            items(snapshot.members, key = { it.id }) { member ->
                NPanel(onClick = members, shape = RoundedCornerShape(9.dp), color = Color.Transparent) {
                    Row(Modifier.widthIn(min = 95.dp).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TeamHarnessMark(member)
                        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(member.harness.ifBlank { member.name }.replace(" Harness", ""), fontSize = 12.sp, lineHeight = 17.sp,
                                fontWeight = FontWeight.SemiBold, color = TeamText, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                Box(Modifier.size(5.dp).background(if (member.status == "running") Green else TeamSecondary, CircleShape))
                                Text(if (member.status == "running") "运行中" else "空闲", fontSize = 10.sp, lineHeight = 15.sp, color = TeamSecondary)
                            }
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            NButton(back, Modifier.weight(1f).height(44.dp).testTag("team-return-chat"), shape = RoundedCornerShape(14.dp)) {
                Icon(Icons.Outlined.ChatBubbleOutline, null, Modifier.size(20.dp)); Spacer(Modifier.width(9.dp))
                Text("返回会话", fontSize = 17.sp, fontWeight = FontWeight.Medium)
            }
            NPanel(onClick = stop, enabled = snapshot.active && !cancelling, shape = RoundedCornerShape(14.dp),
                color = Color.Transparent, border = BorderStroke(.75.dp, TeamText), modifier = Modifier.size(44.dp).testTag("team-stop")) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    if (cancelling) NSpinner(Modifier.size(18.dp)) else Icon(Icons.Outlined.Stop, "停止全部团队任务", Modifier.size(23.dp),
                        tint = if (snapshot.active) TeamText else TeamSecondary)
                }
            }
        }
    }
}

@Composable private fun TeamMembers(snapshot: TeamTaskSnapshot) {
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), contentPadding = PaddingValues(vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items(snapshot.members, key = { it.id }) { member ->
            NPanel(shape = RoundedCornerShape(14.dp), border = BorderStroke(.7.dp, TeamLine), color = MobilePalette.card) {
                Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TeamHarnessMark(member, Modifier.size(32.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(member.name, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = TeamText)
                            Text(listOf(member.harness, member.model).filter(String::isNotBlank).joinToString(" · "), fontSize = 12.sp, lineHeight = 19.sp, color = TeamSecondary)
                        }
                        Text(if (member.status == "running") "运行中" else "空闲", fontSize = 12.sp, color = TeamSecondary)
                    }
                    snapshot.tasks.filter { it.memberId == member.id && !it.completed && it.status != "cancelled" }.forEach { task ->
                        Text(task.title, fontSize = 13.sp, lineHeight = 20.sp, color = TeamText)
                    }
                }
            }
        }
        if (snapshot.members.isEmpty()) item { EmptyView(Icons.Outlined.Groups, "暂无可用成员") }
    }
}
