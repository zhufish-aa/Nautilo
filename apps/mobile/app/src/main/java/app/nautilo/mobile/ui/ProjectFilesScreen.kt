package app.nautilo.mobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.*
import kotlinx.coroutines.delay

@Composable fun ProjectFilesScreen(state: MobileState, model: MobileViewModel) {
    var query by rememberSaveable(state.fileProject?.id) { mutableStateOf("") }
    var appliedQuery by remember { mutableStateOf("") }
    val folder = state.projectFiles.text("path")
    fun open(path: String) { appliedQuery = ""; query = ""; model.browseProjectFiles(path) }
    LaunchedEffect(query) {
        if (query != appliedQuery) { delay(250); appliedQuery = query; model.browseProjectFiles(folder, query = query) }
    }
    Column(Modifier.fillMaxSize().background(MobilePalette.canvas).padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!state.projectFiles.isNull("parent")) ActionIcon(Icons.Outlined.ArrowUpward, "上一级目录") { open(state.projectFiles.text("parent")) }
            Column(Modifier.weight(1f).padding(horizontal = 6.dp)) {
                Text(folder.ifBlank { "项目文件" }, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(state.fileProject?.root.orEmpty(), fontSize = 12.sp, color = Secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            ActionIcon(Icons.Outlined.Refresh, "刷新文件", !state.projectFilesLoading) { model.browseProjectFiles(folder, query = query) }
        }
        NField(query, { query = it }, Modifier.fillMaxWidth().padding(bottom = 8.dp), placeholder = { Text("筛选当前目录", fontSize = 14.sp) },
            leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(18.dp)) }, singleLine = true)
        if (state.projectFilesLoading) NProgress(Modifier.fillMaxWidth())
        LazyColumn(Modifier.weight(1f).testTag("project-file-list"), contentPadding = PaddingValues(bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            items(state.projectFiles.objects("entries"), key = { it.text("path") }) { file ->
                NPanel(onClick = { if (file.optBoolean("directory")) open(file.text("path")) else model.previewFile(FileReference(file.text("path"))) }, shape = RoundedCornerShape(13.dp)) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (file.optBoolean("directory")) Icon(Icons.Outlined.FolderOpen, null, Modifier.size(22.dp), tint = Secondary) else FileTypeIcon(file.text("path"))
                        Text(file.text("name"), Modifier.weight(1f), fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (file.optBoolean("directory")) Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp), tint = Secondary)
                        else Text(fileSize(file.optLong("size")), fontSize = 11.sp, color = Secondary)
                    }
                }
            }
            if (!state.projectFiles.isNull("nextOffset")) item("more") {
                NTextButton({ model.browseProjectFiles(folder, state.projectFiles.optInt("nextOffset"), query) }, enabled = !state.projectFilesLoading) { Text("加载更多") }
            }
            if (!state.projectFilesLoading && state.error.isBlank() && state.projectFiles.objects("entries").isEmpty()) item("empty") { EmptyView(Icons.Outlined.FolderOpen, if (query.isBlank()) "这个目录是空的" else "没有匹配的文件") }
            if (state.projectFiles.optBoolean("scanLimited")) item("limit") { Text("目录较大，请缩小筛选范围", fontSize = 12.sp, color = Secondary) }
        }
    }
}

internal fun fileSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${(bytes + 1023) / 1024} KB"
    else -> "${"%.1f".format(java.util.Locale.ROOT, bytes / 1048576.0)} MB"
}
