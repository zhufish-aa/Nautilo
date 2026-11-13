package app.nautilo.mobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.Screen
import app.nautilo.mobile.data.Conversation

@Composable fun ProjectsScreen(state: MobileState, model: MobileViewModel, searching: Boolean, closeSearch: () -> Unit, pair: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val collapsed = remember { mutableStateMapOf<String, Boolean>() }
    val counts = remember { mutableStateMapOf<String, Int>() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        item("computer") {
            Surface(onClick = { if (state.host == null) pair() else model.navigate(Screen.Computers) },
                shape = RoundedCornerShape(23.dp), color = Color(0xFFEDF5FB), border = BorderStroke(1.dp, Color(0xFFDCEAF4))) {
                Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Box(Modifier.size(44.dp).background(Color.White.copy(alpha = .85f), RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.DesktopWindows, null, Modifier.size(24.dp), tint = Blue) }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(state.host?.name ?: "连接我的电脑", fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Dot(state.connected)
                            Text(if (state.host == null) "扫描配对码" else if (state.connected) "已连接 · ${state.projects.size} 个项目" else if (state.connecting) "正在连接" else "点此重新连接", fontSize = 12.sp, color = Secondary)
                        }
                    }
                    if (state.connecting) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 1.6.dp)
                    else Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = Blue)
                }
            }
        }
        if (searching) item("search") {
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), placeholder = { Text("搜索项目或会话", fontSize = 14.sp) }, singleLine = true, shape = RoundedCornerShape(15.dp), leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(19.dp)) }, trailingIcon = { ActionIcon(Icons.Outlined.Close, "结束搜索") { query = ""; closeSearch() } })
        }
        item("heading") {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("我的项目", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text("${state.projects.size}", fontSize = 12.sp, color = Secondary)
                Spacer(Modifier.width(6.dp))
                if (state.host != null) ActionIcon(Icons.Outlined.Add, "新建会话") { model.beginConversation() }
            }
        }
        state.projects.forEach { project ->
            val sessions = state.sessions.filter { it.projectId == project.id && (query.isBlank() || it.title.contains(query, true) || project.name.contains(query, true)) }
            if (query.isBlank() || sessions.isNotEmpty() || project.name.contains(query, true)) item("project:${project.id}") {
                Surface(shape = RoundedCornerShape(21.dp), color = Color.White.copy(alpha = .94f), border = BorderStroke(1.dp, Line.copy(alpha = .8f))) {
                    Column(Modifier.fillMaxWidth().padding(8.dp)) {
                        Surface(onClick = { collapsed[project.id] = !(collapsed[project.id] ?: false) }, color = Color.Transparent, shape = RoundedCornerShape(14.dp)) {
                            Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                                Icon(Icons.Outlined.FolderOpen, null, tint = Blue, modifier = Modifier.size(23.dp))
                                Text(project.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                                Text("${sessions.size}", fontSize = 12.sp, color = Secondary)
                                Icon(if (collapsed[project.id] == true) Icons.Outlined.ChevronRight else Icons.Outlined.ExpandMore, null, tint = Secondary, modifier = Modifier.size(17.dp))
                            }
                        }
                        AnimatedVisibility(collapsed[project.id] != true) {
                            Column {
                                val limit = counts[project.id] ?: 5
                                sessions.take(limit).forEach { session -> key(session.id) { SessionListRow(session, state.session?.id == session.id) { model.openSession(session) } } }
                                if (sessions.size > limit) TextButton(onClick = { counts[project.id] = limit + 20 }, modifier = Modifier.padding(start = 35.dp)) { Text("更多会话", color = Secondary, fontSize = 12.sp); Icon(Icons.Outlined.ExpandMore, null, Modifier.padding(start = 4.dp).size(14.dp)) }
                                if (sessions.isEmpty()) TextButton(onClick = { model.beginConversation() }, modifier = Modifier.padding(start = 35.dp)) { Text("新建会话", fontSize = 12.sp) }
                            }
                        }
                    }
                }
            }
        }
        if (state.projects.isEmpty()) item("empty") {
            EmptyView(Icons.Outlined.FolderOpen, if (state.host == null) "把电脑工作区带在身边" else if (state.connecting) "正在连接电脑" else "还没有项目", action = { TextButton(onClick = { if (state.host == null) pair() else model.beginConversation() }) { Text(if (state.host == null) "连接电脑" else "新建项目") } })
        }
    }
}

@Composable private fun SessionListRow(session: Conversation, selected: Boolean, open: () -> Unit) {
    Surface(onClick = open, color = if (selected) Selection.copy(alpha = .8f) else Color.Transparent, shape = RoundedCornerShape(13.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 15.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Outlined.ChatBubbleOutline, null, Modifier.size(16.dp), tint = if (selected) Blue else Secondary)
            Text(session.title, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp, fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal)
            if (session.status in listOf("running", "waiting", "starting")) Box(Modifier.size(5.dp).background(Blue, CircleShape))
            else Text(shortTime(session.updatedAt), fontSize = 10.sp, color = Secondary)
        }
    }
}
