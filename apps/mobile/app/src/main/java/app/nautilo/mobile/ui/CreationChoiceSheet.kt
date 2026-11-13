@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package app.nautilo.mobile.ui

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
import app.nautilo.mobile.data.*

enum class CreationPicker { Project, Harness, Connection, Model, Effort }

@Composable fun CreationChoiceSheet(
    field: CreationPicker, state: MobileState, project: String, agent: String, connection: String, model: String, effort: String,
    refresh: () -> Unit, newProject: () -> Unit, dismiss: () -> Unit, select: (String) -> Unit
) {
    var query by remember { mutableStateOf("") }
    val choices = when (field) {
        CreationPicker.Project -> state.projects.map { it.id to it.name }
        CreationPicker.Harness -> state.setup.objects("agents").map { it.text("id") to it.text("name") }
        CreationPicker.Connection -> listOf("" to "使用 Harness 原生配置") + state.setup.objects("connections").map { it.text("id") to it.text("name") }
        CreationPicker.Model -> state.newModels.map { it.text("id") to it.text("displayName", it.text("id")) }
        CreationPicker.Effort -> state.newModels.find { it.text("id") == model }?.strings("reasoningEfforts").orEmpty().map { it to effortName(it) }
    }
    val selected = when(field) { CreationPicker.Project -> project; CreationPicker.Harness -> agent; CreationPicker.Connection -> connection; CreationPicker.Model -> model; CreationPicker.Effort -> effort }
    val icon = when(field) { CreationPicker.Project -> Icons.Outlined.FolderOpen; CreationPicker.Harness -> Icons.Outlined.ViewInAr; CreationPicker.Connection -> Icons.Outlined.PersonOutline; CreationPicker.Model -> Icons.Outlined.Layers; CreationPicker.Effort -> Icons.Outlined.Psychology }
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Color(0xFFFCFDFE)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(when(field) { CreationPicker.Project -> "选择项目"; CreationPicker.Harness -> "选择 Harness"; CreationPicker.Connection -> "账号与供应商"; CreationPicker.Model -> "选择模型"; CreationPicker.Effort -> "推理强度" }, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                if (field == CreationPicker.Model) ActionIcon(Icons.Outlined.Refresh, "刷新模型", !state.catalogLoading, refresh)
                if (field == CreationPicker.Project) TextButton(onClick = newProject) { Icon(Icons.Outlined.Add, null, Modifier.size(17.dp)); Text("新建项目", fontSize = 13.sp) }
            }
            if (choices.size > 6) OutlinedTextField(query, { query = it }, placeholder = { Text("搜索", fontSize = 14.sp) }, leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(18.dp)) }, singleLine = true, shape = RoundedCornerShape(15.dp), modifier = Modifier.fillMaxWidth())
            if (field == CreationPicker.Model && state.catalogLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
            LazyColumn(Modifier.heightIn(max = 360.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                items(choices.filter { it.second.contains(query, ignoreCase = true) }, key = { it.first }) { (id, title) ->
                    Surface(onClick = { select(id) }, color = if (selected == id) Selection else Color.Transparent, shape = RoundedCornerShape(14.dp)) {
                        Row(Modifier.fillMaxWidth().heightIn(min = 49.dp).padding(horizontal = 13.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Icon(icon, null, Modifier.size(19.dp), tint = if (selected == id) Blue else Secondary)
                            Text(title, fontSize = 14.sp, fontWeight = if (selected == id) FontWeight.Medium else FontWeight.Normal, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (selected == id) Icon(Icons.Outlined.Check, null, Modifier.size(18.dp), tint = Blue)
                        }
                    }
                }
                if (choices.isEmpty() && !state.catalogLoading) item { Text("使用电脑上的默认配置", Modifier.padding(16.dp), color = Secondary, fontSize = 14.sp) }
            }
        }
    }
}
