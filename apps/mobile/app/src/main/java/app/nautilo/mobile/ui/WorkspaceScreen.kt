package app.nautilo.mobile.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.Screen
import app.nautilo.mobile.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable fun WorkspaceScreen(state: MobileState, model: MobileViewModel) {
    var query by remember(state.session?.id) { mutableStateOf("") }
    val files by produceState<List<Pair<FileChange, String>>>(emptyList(), state.workspace) {
        value = withContext(Dispatchers.Default) {
            state.workspace.map { FileChange.decode(it) to it.text("changeType") }
                .filter { (file, _) -> !file.verifiedDiff || file.added > 0 || file.removed > 0 }
        }
    }
    val filtered = remember(files, query) { files.filter { it.first.path.contains(query, true) } }
    val palette = MobilePalette
    val motion = LocalNautiloMotion.current
    val sweep = remember { Animatable(1f) }
    val scope = rememberCoroutineScope()
    val session = state.session
    val direction = RoundedCornerShape(16.dp)
    val team = session?.teamId.orEmpty()
    val canOpenTeam = team.isNotBlank() && state.connected && "session.team" in state.capabilities
    val harness = state.setup.objects("agents").firstOrNull { it.text("id") == session?.agentId }?.text("name")
        .takeUnless { it.isNullOrBlank() } ?: session?.provider?.ifBlank { "当前 Harness" } ?: "当前 Harness"
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 12.dp, 16.dp, 76.dp)) {
            item("agents") {
                NPanel(onClick = if (canOpenTeam) ({ model.teamTasks() }) else null, shape = direction, border = BorderStroke(1.dp, Line)) {
                    Column(Modifier.fillMaxWidth().padding(16.dp, 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Box(Modifier.size(38.dp).background(palette.inset, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
                                Icon(Icons.Outlined.ViewInAr, null, Modifier.size(21.dp), tint = Accent)
                            }
                            Column(Modifier.weight(1f)) {
                                Text(harness, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("工作区代理", fontSize = 11.sp, color = Secondary)
                            }
                            Row(Modifier.widthIn(max = 130.dp).background(Selection, CircleShape).padding(horizontal = 9.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically) {
                                Text(teamSelectionName(team, state), color = Accent, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, false))
                                if (canOpenTeam) Icon(Icons.Outlined.ChevronRight, null, Modifier.size(14.dp), tint = Accent)
                            }
                        }
                        state.members.forEach { member ->
                            NDivider()
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Icon(Icons.Outlined.PersonOutline, null, Modifier.size(16.dp), tint = Secondary)
                                Text(member.text("name", "团队成员"), Modifier.weight(1f), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(member.text("model").substringAfterLast('/'), color = Secondary, fontSize = 11.sp, maxLines = 1)
                            }
                        }
                    }
                }
                Spacer(Modifier.height(14.dp))
            }
            item("files-heading") {
                val hasRows = filtered.isNotEmpty()
                val shape = if (hasRows) RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp) else direction
                NPanel(shape = shape, border = BorderStroke(1.dp, Line)) {
                    Column(Modifier.fillMaxWidth()) {
                        Box {
                            Row(Modifier.fillMaxWidth().padding(16.dp, 13.dp), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                                Text("文件变更", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                                Text("${files.size} 个文件", Modifier.weight(1f), fontFamily = CodeFont, fontSize = 11.sp, color = Secondary)
                                if (files.any { it.first.verifiedDiff }) ChangeCount(files.sumOf { it.first.added }, files.sumOf { it.first.removed })
                                NPanel(onClick = {
                                    if (motion) scope.launch {
                                        sweep.snapTo(0f)
                                        sweep.animateTo(1f, tween(480, easing = MotionEase))
                                    }
                                    model.workspace()
                                }, modifier = Modifier.size(34.dp), enabled = !state.workspaceLoading,
                                    shape = CircleShape, color = palette.inset) {
                                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                        Icon(Icons.Outlined.Refresh, "刷新变更", Modifier.size(18.dp).graphicsLayer {
                                            rotationZ = if (motion) sweep.value * 360f else 0f
                                        }, tint = Secondary)
                                    }
                                }
                            }
                            if (motion) Box(Modifier.matchParentSize().graphicsLayer {
                                translationX = size.width * (sweep.value * 2f - 1f)
                                alpha = .12f * (1f - sweep.value)
                            }.background(Brush.horizontalGradient(listOf(Color.Transparent, palette.accent, Color.Transparent))))
                        }
                        NDivider()
                        if (files.size > 5) {
                            NField(query, { query = it }, Modifier.fillMaxWidth().padding(12.dp), placeholder = { Text("查找文件", fontSize = 13.sp) },
                                leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(17.dp), tint = Secondary) }, singleLine = true)
                        }
                        if (state.workspaceLoading) NProgress(Modifier.fillMaxWidth())
                        if (!state.workspaceLoading && !hasRows) Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 36.dp),
                            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Box(Modifier.size(48.dp).background(Selection, RoundedCornerShape(13.dp)), contentAlignment = Alignment.Center) {
                                Box(Modifier.size(34.dp).background(palette.card, RoundedCornerShape(9.dp)), contentAlignment = Alignment.Center) {
                                    Icon(Icons.Outlined.Difference, null, Modifier.size(20.dp), tint = Accent)
                                }
                            }
                            Text(if (query.isBlank()) "工作区干净，暂无文件变更" else "没有匹配的文件", fontSize = 14.sp,
                                fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
                            if (query.isBlank()) Text("Agent 修改代码后将在此显示差异", fontSize = 12.sp, color = Secondary, textAlign = TextAlign.Center)
                        }
                    }
                }
            }
            itemsIndexed(filtered, key = { _, pair -> pair.first.path }) { index, (file, type) ->
                NPanel(onClick = { model.openDiff(file.path) }, modifier = Modifier.fillMaxWidth(), border = BorderStroke(1.dp, Line),
                    shape = if (index == filtered.lastIndex) RoundedCornerShape(bottomStart = 16.dp, bottomEnd = 16.dp) else RoundedCornerShape(0.dp)) {
                    MotionArrival(file.path, true, 5.dp, delayMs = (index % 5) * 25) {
                        Row(Modifier.fillMaxWidth().padding(14.dp, 11.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                            FileTypeIcon(file.path)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(file.name, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (file.folder.isNotBlank()) Text(file.folder, fontSize = 11.sp, color = Secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            if (file.verifiedDiff) ChangeCount(file.added, file.removed)
                            when (type) {
                                "added" -> FileStatus("A", Green)
                                "deleted" -> FileStatus("D", Danger)
                                "modified" -> FileStatus("M", palette.amber)
                            }
                            Icon(Icons.Outlined.ChevronRight, null, Modifier.size(15.dp), tint = Secondary)
                        }
                    }
                }
            }
        }
        Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp)) {
            MotionArrival(session?.id, true, 8.dp) {
                NPanel(onClick = { model.navigate(Screen.Chat) }, modifier = Modifier.height(44.dp), shape = CircleShape, color = palette.floating,
                    shadowElevation = 4.dp, border = BorderStroke(1.dp, palette.edge)) {
                    Row(Modifier.padding(horizontal = 22.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(Icons.Outlined.ArrowBack, null, Modifier.size(17.dp), tint = Accent)
                        Text("返回会话", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
    }
}

@Composable private fun FileStatus(label: String, tone: Color) {
    Text(label, Modifier.background(tone.copy(alpha = .10f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 2.dp),
        color = tone, fontFamily = CodeFont, fontSize = 11.sp)
}
