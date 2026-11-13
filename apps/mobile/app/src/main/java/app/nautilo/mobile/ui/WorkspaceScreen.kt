package app.nautilo.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
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
import app.nautilo.mobile.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable fun WorkspaceScreen(state: MobileState, model: MobileViewModel) {
    var query by remember { mutableStateOf("") }
    val files by produceState<List<FileChange>>(emptyList(), state.workspace) {
        value = withContext(Dispatchers.Default) {
            state.workspace.map(FileChange::decode).filter { !it.verifiedDiff || it.added > 0 || it.removed > 0 }
        }
    }
    val filtered = remember(files, query) { files.filter { it.path.contains(query, true) } }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 10.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            item("summary") {
                Surface(shape = RoundedCornerShape(22.dp), color = Color.White, border = BorderStroke(1.dp, Line.copy(alpha = .7f))) {
                    Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("文件变更", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("${files.size} 个文件", fontSize = 12.sp, color = Secondary)
                                if (files.any { it.verifiedDiff }) {
                                    Text("+${files.sumOf { it.added }}", color = Green, fontSize = 12.sp)
                                    Text("−${files.sumOf { it.removed }}", color = Danger, fontSize = 12.sp)
                                }
                            }
                        }
                        Surface(shape = RoundedCornerShape(13.dp), color = Selection.copy(alpha = .6f)) {
                            ActionIcon(Icons.Outlined.Refresh, "刷新变更", !state.workspaceLoading) { model.workspace() }
                        }
                    }
                }
            }
            if (files.size > 5) item("search") { OutlinedTextField(query, { query = it }, modifier = Modifier.fillMaxWidth(), placeholder = { Text("查找文件", fontSize = 13.sp) }, leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(18.dp)) }, shape = RoundedCornerShape(15.dp), singleLine = true) }
            if (state.workspaceLoading) item("loading") { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            items(filtered, key = { it.path }) { change ->
                Surface(onClick = { model.openDiff(change.path) }, shape = RoundedCornerShape(17.dp), color = Color.White.copy(alpha = .88f)) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        FileTypeIcon(change.path)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(change.name, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(change.folder, fontSize = 11.sp, color = Secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (change.verifiedDiff) ChangeCount(change.added, change.removed)
                        Icon(Icons.Outlined.ChevronRight, null, Modifier.size(17.dp), tint = Secondary)
                    }
                }
            }
            if (!state.workspaceLoading && filtered.isEmpty()) item("empty") { EmptyView(Icons.Outlined.Difference, if (query.isBlank()) "还没有文件变更" else "没有匹配的文件") }
            item("agents") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                        Icon(Icons.Outlined.Workspaces, null, Modifier.size(18.dp), tint = Blue)
                        Text("工作区代理", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        if (state.members.isNotEmpty()) Text("${state.members.size}", fontSize = 12.sp, color = Secondary)
                    }
                    Surface(shape = RoundedCornerShape(18.dp), color = Color.White.copy(alpha = .8f)) {
                        Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            if (state.members.isEmpty()) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                Icon(Icons.Outlined.ViewInAr, null, Modifier.size(20.dp), tint = Blue)
                                Text(state.session?.provider?.ifBlank { "当前 Harness" } ?: "当前 Harness", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                                Spacer(Modifier.weight(1f))
                                Text("独立工作", fontSize = 12.sp, color = Secondary)
                            }
                            state.members.forEach { member -> Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Outlined.PersonOutline, null, Modifier.size(20.dp), tint = Blue)
                                Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                    Text(member.text("name", "团队成员"), fontSize = 13.sp, fontWeight = FontWeight.Medium)
                                    Text(member.text("model").substringAfterLast('/'), fontSize = 11.sp, color = Secondary)
                                }
                            } }
                        }
                    }
                }
            }
        }
        TextButton(onClick = { model.navigate(Screen.Chat) }, modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp).height(46.dp)) {
            Icon(Icons.Outlined.ChatBubbleOutline, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("返回会话", color = Ink)
        }
    }
}
