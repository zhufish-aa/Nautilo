package app.nautilo.mobile.ui

import androidx.compose.animation.core.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
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
    val session = state.session
    var query by remember(session?.id) { mutableStateOf("") }
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
    val shape = RoundedCornerShape(18.dp)
    val team = session?.teamId.orEmpty()
    val canOpenTeam = team.isNotBlank() && state.connected && "session.team" in state.capabilities
    val harness = state.setup.objects("agents").firstOrNull { it.text("id") == session?.agentId }?.text("name")
        .takeUnless { it.isNullOrBlank() } ?: session?.provider?.ifBlank { "当前 Harness" } ?: "当前 Harness"
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 76.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                NPanel(onClick = if (canOpenTeam) ({ model.teamTasks() }) else null,
                    modifier = Modifier.weight(1.15f).height(116.dp), shape = shape, border = BorderStroke(1.dp, palette.mirror)) {
                    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.SpaceBetween) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Box(Modifier.size(36.dp).background(palette.inset, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
                                Icon(Icons.Outlined.ViewInAr, null, Modifier.size(20.dp), tint = palette.brightAccent)
                            }
                            Spacer(Modifier.weight(1f))
                            Text(teamSelectionName(team, state), Modifier
                                .background(Accent.copy(alpha = .18f), CircleShape)
                                .border(1.dp, Accent.copy(alpha = .34f), CircleShape)
                                .padding(horizontal = 7.dp, vertical = 3.dp),
                                color = palette.brightAccent, fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1,
                                overflow = TextOverflow.Ellipsis)
                        }
                        Column {
                            Text(harness, color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("工作区代理", color = Secondary, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                }
                NPanel(modifier = Modifier.weight(1f).height(116.dp), shape = shape, border = BorderStroke(1.dp, palette.mirror)) {
                    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.SpaceBetween) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text("文件变更", Modifier.weight(1f), color = Secondary, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                            NIconButton(onClick = {
                                if (motion) scope.launch {
                                    sweep.snapTo(0f)
                                    sweep.animateTo(1f, tween(480, easing = MotionEase))
                                }
                                model.workspace()
                            }, modifier = Modifier.size(32.dp).background(palette.inset, CircleShape),
                                enabled = state.connected && !state.workspaceLoading) {
                                Icon(Icons.Outlined.Refresh, "刷新变更", Modifier.size(17.dp).graphicsLayer {
                                    rotationZ = sweep.value * 360f
                                }, tint = Secondary)
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                            Text(files.size.toString(), color = Ink, fontSize = 30.sp, fontFamily = CodeFont, maxLines = 1)
                            if (files.isEmpty() && state.connected && !state.workspaceLoading) {
                                Dot(true)
                                Text("干净", color = Green, fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                            }
                        }
                    }
                }
            }
            if (state.members.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                state.members.forEach { member ->
                    Text(listOf(member.text("name", "团队成员"), member.text("model").substringAfterLast('/'))
                        .filter(String::isNotBlank).joinToString(" · "), Modifier.background(palette.inset, CircleShape)
                        .padding(horizontal = 9.dp, vertical = 4.dp), color = Secondary, fontSize = 11.sp)
                }
            }
            NPanel(modifier = Modifier.weight(1f).fillMaxWidth(), shape = RoundedCornerShape(20.dp),
                border = BorderStroke(1.dp, palette.mirror), shadowElevation = if (palette.dark) 0.dp else 2.dp) {
                Column(Modifier.fillMaxSize()) {
                    Box {
                        Row(Modifier.fillMaxWidth().heightIn(min = 46.dp).padding(horizontal = 14.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Text("变更清单", Modifier.weight(1f), color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                            if ((state.connected && !state.workspaceLoading && files.isEmpty()) || files.any { it.first.verifiedDiff }) {
                                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                    Text("+${files.sumOf { it.first.added }}", color = Green, fontFamily = CodeFont, fontSize = 11.sp)
                                    Text("−${files.sumOf { it.first.removed }}", color = Danger, fontFamily = CodeFont, fontSize = 11.sp)
                                }
                            }
                        }
                        if (motion) Box(Modifier.matchParentSize().graphicsLayer {
                            translationX = size.width * (sweep.value * 2f - 1f)
                            alpha = .10f * (1f - sweep.value)
                        }.background(Brush.horizontalGradient(listOf(Color.Transparent, Accent, Color.Transparent))))
                    }
                    NDivider()
                    if (files.size > 5) {
                        NField(query, { query = it }, Modifier.fillMaxWidth().padding(12.dp), placeholder = { Text("查找文件", fontSize = 13.sp) },
                            leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(17.dp), tint = Secondary) }, singleLine = true)
                    }
                    if (state.workspaceLoading) NProgress(Modifier.fillMaxWidth())
                    if (filtered.isNotEmpty()) LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                        itemsIndexed(filtered, key = { _, pair -> pair.first.path }) { index, (file, type) ->
                            if (index > 0) NDivider(Modifier.padding(horizontal = 14.dp))
                            NPanel(onClick = { model.openDiff(file.path) }, modifier = Modifier.fillMaxWidth(),
                                color = Color.Transparent, shape = RoundedCornerShape(0.dp)) {
                                Row(Modifier.fillMaxWidth().padding(14.dp, 11.dp), verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                                    FileTypeIcon(file.path)
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        Text(file.name, color = Ink, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
                    } else if (!state.workspaceLoading) Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
                        val clean = state.connected && query.isBlank()
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (clean) {
                                CleanWorkspaceBlueprint()
                                Spacer(Modifier.height(2.dp))
                            }
                            Text(when {
                                query.isNotBlank() -> "没有匹配的文件"
                                clean -> "工作区干净，暂无文件变更"
                                else -> "等待电脑连接"
                            }, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
                            if (clean) Text("Agent 修改代码后将在此显示差异", fontSize = 12.sp, color = Secondary, textAlign = TextAlign.Center)
                        }
                    }
                }
            }
        }
        Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp)) {
            MotionArrival(session?.id, true, 8.dp) {
                NPanel(onClick = { model.navigate(Screen.Chat) }, modifier = Modifier.height(46.dp), shape = CircleShape,
                    color = palette.floating, shadowElevation = 5.dp, border = BorderStroke(1.dp, palette.mirror)) {
                    Row(Modifier.padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(Icons.Outlined.ChatBubbleOutline, null, Modifier.size(17.dp), tint = palette.brightAccent)
                        Text("返回会话", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
    }
}

@Composable private fun CleanWorkspaceBlueprint() {
    val palette = MobilePalette
    val breathe = if (LocalNautiloMotion.current) rememberInfiniteTransition(label = "clean-workspace")
        .animateFloat(.45f, .85f, infiniteRepeatable(tween(2400), RepeatMode.Reverse), label = "check-halo") else null
    Box(Modifier.size(132.dp, 84.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.matchParentSize()) {
            val line = 1.dp.toPx()
            drawRoundRect(palette.inset, cornerRadius = CornerRadius(12.dp.toPx()))
            drawRoundRect(palette.edge, Offset(line / 2, line / 2), Size(size.width - line, size.height - line),
                CornerRadius(12.dp.toPx()), style = androidx.compose.ui.graphics.drawscope.Stroke(line))
            listOf(.52f, .72f, .42f, .61f).forEachIndexed { index, width ->
                drawRoundRect(palette.secondary.copy(alpha = .22f), Offset(15.dp.toPx(), (18 + index * 14).dp.toPx()),
                    Size(size.width * width, 3.dp.toPx()), CornerRadius(2.dp.toPx()))
            }
        }
        Box(Modifier.align(Alignment.CenterEnd).padding(end = 14.dp).size(48.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.matchParentSize().graphicsLayer { alpha = breathe?.value ?: .60f }
                .background(palette.mark.copy(alpha = .13f), CircleShape))
            Box(Modifier.size(31.dp).background(palette.card, CircleShape).border(1.dp, palette.mark.copy(alpha = .45f), CircleShape),
                contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Check, null, Modifier.size(18.dp), tint = Green)
            }
        }
    }
}

@Composable private fun FileStatus(label: String, tone: Color) {
    Text(label, Modifier.background(tone.copy(alpha = .10f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 2.dp),
        color = tone, fontFamily = CodeFont, fontSize = 11.sp)
}
