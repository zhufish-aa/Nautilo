package app.nautilo.mobile.ui

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.Screen
import app.nautilo.mobile.data.Conversation

@Composable fun ProjectsScreen(state: MobileState, model: MobileViewModel, searching: Boolean, closeSearch: () -> Unit, pair: () -> Unit,
    listState: LazyListState = rememberLazyListState()) {
    var query by rememberSaveable { mutableStateOf("") }
    var newProject by rememberSaveable { mutableStateOf(false) }
    val collapsed = remember(state.host?.id) { mutableStateMapOf<String, Boolean>() }
    val counts = remember(state.host?.id) { mutableStateMapOf<String, Int>() }
    val palette = MobilePalette
    val motion = LocalNautiloMotion.current
    LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(16.dp, 12.dp, 16.dp, 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item("computer") {
            NPanel(onClick = { if (state.host == null) pair() else model.navigate(Screen.Computers) },
                shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, Line), shadowElevation = if (palette.dark) 0.dp else 1.dp) {
                Row(Modifier.fillMaxWidth().drawWithCache {
                    val glow = Brush.radialGradient(listOf(palette.green.copy(alpha = .09f), Color.Transparent),
                        center = Offset(size.width * .92f, 0f), radius = size.width * .49f)
                    onDrawBehind {
                        if (state.connected && palette.dark) drawRect(glow)
                        drawLine(palette.highlight, Offset(16.dp.toPx(), 1.dp.toPx()), Offset(size.width - 16.dp.toPx(), 1.dp.toPx()))
                    }
                }.padding(16.dp, 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(Modifier.size(40.dp).background(palette.inset, RoundedCornerShape(11.dp)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.DesktopWindows, null, Modifier.size(22.dp), tint = Accent)
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(state.host?.name ?: "连接我的电脑", fontSize = 15.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-.15).sp,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                            HostSignal(state.connected)
                            Text(when {
                                state.host == null -> "扫描配对码"
                                state.connected -> "已连接 · ${state.projects.size} 个项目"
                                state.connecting -> "正在连接"
                                else -> "点此重新连接"
                            }, fontSize = 12.sp, color = Secondary, modifier = Modifier.weight(1f, false), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (state.connected) state.latency?.let { Text("${it}ms", fontFamily = CodeFont, fontSize = 10.sp, color = Secondary, maxLines = 1) }
                        }
                    }
                    if (state.connecting) NSpinner(Modifier.size(16.dp), strokeWidth = 1.6.dp, color = Accent)
                    else Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = Secondary)
                }
            }
        }
        if (searching) item("search") {
            NField(query, { query = it }, Modifier.fillMaxWidth(), placeholder = { Text("搜索项目或会话", fontSize = 14.sp) },
                singleLine = true, leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(18.dp), tint = Secondary) },
                trailingIcon = { ActionIcon(Icons.Outlined.Close, "结束搜索") { query = ""; closeSearch() } })
        }
        item("heading") {
            Row(Modifier.fillMaxWidth().padding(horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("我的项目", fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Text("${state.projects.size}", Modifier.background(palette.inset, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
                    color = Secondary, fontFamily = CodeFont, fontSize = 11.sp)
                Spacer(Modifier.weight(1f))
                if (state.host != null) NPanel({ newProject = true }, Modifier.size(36.dp).testTag("projects-create-project"), shape = CircleShape, color = Selection) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Add, "新建项目", Modifier.size(18.dp), tint = Accent) }
                }
            }
        }
        state.projects.forEach { project ->
            val all = state.sessions.filter { it.projectId == project.id }
            val foundProject = project.name.contains(query, true)
            val sessions = if (foundProject || query.isBlank()) all else all.filter { it.title.contains(query, true) }
            if (foundProject || sessions.isNotEmpty()) item("project:${project.id}") {
                val expanded = collapsed[project.id] != true || query.isNotBlank()
                val limit = counts[project.id] ?: 5
                val caret = animateFloatAsState(if (expanded) 180f else 0f, tween(if (motion) 200 else 0, easing = MotionEase), label = "project-caret")
                NPanel(shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, Line), shadowElevation = if (palette.dark) 0.dp else 1.dp) {
                    Column(Modifier.fillMaxWidth()) {
                        Row(Modifier.padding(start = 4.dp, end = 10.dp).heightIn(min = 52.dp), verticalAlignment = Alignment.CenterVertically) {
                            NPanel({ collapsed[project.id] = expanded }, Modifier.weight(1f), color = Color.Transparent) {
                                Row(Modifier.fillMaxWidth().padding(horizontal = 9.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Icon(Icons.Outlined.FolderOpen, null, Modifier.size(19.dp), tint = Accent)
                                    Text(project.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f, false),
                                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text("${all.size}", fontFamily = CodeFont, fontSize = 11.sp, color = Secondary)
                                    Icon(Icons.Outlined.ExpandMore, if (expanded) "收起会话" else "展开会话", Modifier.size(16.dp).graphicsLayer { rotationZ = caret.value }, tint = Secondary)
                                }
                            }
                            NIconButton({ model.openProjectFiles(project.id) }, Modifier.size(36.dp).testTag("project-files:${project.id}")) {
                                Icon(Icons.Outlined.AccountTree, "浏览 ${project.name} 文件", Modifier.size(17.dp), tint = Secondary)
                            }
                            NPanel({ model.beginConversation(project.id) }, Modifier.size(28.dp).testTag("project-new-session:${project.id}"),
                                shape = CircleShape, color = Selection) {
                                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Add, "在 ${project.name} 新建会话", Modifier.size(16.dp), tint = Accent) }
                            }
                        }
                        AnimatedVisibility(expanded,
                            enter = expandVertically(tween(if (motion) 260 else 0, easing = MotionEase)),
                            exit = shrinkVertically(tween(if (motion) 260 else 0, easing = MotionEase))) {
                            Column(Modifier.animateContentSize(tween(if (motion) 260 else 0, easing = MotionEase))) {
                                NDivider()
                                if (sessions.isEmpty()) NTextButton(onClick = { model.beginConversation(project.id) }, Modifier.fillMaxWidth().height(40.dp)) {
                                    Text("新建会话", color = Accent, fontSize = 12.sp)
                                }
                                sessions.take(limit).forEachIndexed { index, session -> key(session.id) {
                                    if (index > 0) NDivider(Modifier.padding(horizontal = 16.dp))
                                    MotionArrival(session.id, animate = true, distance = 5.dp, delayMs = (index % 5) * 22) {
                                        SessionListRow(session, state.session?.id == session.id) { model.openSession(session) }
                                    }
                                } }
                                if (sessions.size > limit) {
                                    NDivider()
                                    NPanel({ counts[project.id] = limit + 20 }, Modifier.fillMaxWidth().height(40.dp), color = Color.Transparent) {
                                        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                                            Text("更多会话", color = Secondary, fontSize = 12.sp)
                                            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(14.dp), tint = Secondary)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if (state.projects.isEmpty()) item("empty") {
            EmptyView(Icons.Outlined.FolderOpen, if (state.host == null) "把电脑工作区带在身边" else if (state.connecting) "正在连接电脑" else "还没有项目",
                action = { NTextButton({ if (state.host == null) pair() else newProject = true }) { Text(if (state.host == null) "连接电脑" else "新建项目") } })
        }
    }
    if (newProject) NewProjectSheet(state, model, { newProject = false }) { newProject = false }
}

@Composable private fun SessionListRow(session: Conversation, selected: Boolean, open: () -> Unit) {
    NPanel(open, Modifier.fillMaxWidth().heightIn(min = 44.dp), color = if (selected) Selection else Color.Transparent) {
        Row(Modifier.padding(16.dp, 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            Text(session.title, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp, fontWeight = FontWeight.Normal)
            if (session.status in listOf("running", "waiting", "starting")) Dot(true)
            Text(shortTime(session.updatedAt), fontFamily = CodeFont, fontSize = 12.sp, color = Secondary)
        }
    }
}
