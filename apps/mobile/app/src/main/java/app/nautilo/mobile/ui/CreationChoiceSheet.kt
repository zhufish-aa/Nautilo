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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.data.*

enum class CreationPicker { Project, Harness, Connection, Model, Team }

@Composable fun CreationChoiceSheet(
    field: CreationPicker, state: MobileState, selected: String,
    refresh: () -> Unit, newProject: () -> Unit, dismiss: () -> Unit, select: (String) -> Unit
) {
    NSheet(onDismissRequest = dismiss) {
        CreationChoiceContent(field, state, selected, refresh, newProject, dismiss, select = select)
    }
}

@Composable internal fun CreationChoiceContent(
    field: CreationPicker, state: MobileState, selected: String,
    refresh: () -> Unit, newProject: () -> Unit, dismiss: () -> Unit, selectionEnabled: Boolean = true, select: (String) -> Unit
) {
    if (field == CreationPicker.Team) {
        TeamChoiceContent(state, selected, refresh, dismiss, select)
        return
    }
    var query by remember { mutableStateOf("") }
    val choices = when (field) {
        CreationPicker.Project -> state.projects.map { it.id to it.name }
        CreationPicker.Harness -> state.setup.objects("agents").map { it.text("id") to it.text("name") }
        CreationPicker.Connection -> listOf("" to "使用 Harness 原生配置") + state.setup.objects("connections").map { it.text("id") to it.text("name") }
        CreationPicker.Model -> state.newModels.map { it.text("id") to it.text("displayName", it.text("id")) }
        CreationPicker.Team -> emptyList()
    }
    val icon = when(field) { CreationPicker.Project -> Icons.Outlined.FolderOpen; CreationPicker.Harness -> Icons.Outlined.ViewInAr; CreationPicker.Connection -> Icons.Outlined.PersonOutline; CreationPicker.Model -> Icons.Outlined.Layers; CreationPicker.Team -> Icons.Outlined.Groups }
        Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).padding(horizontal = 20.dp).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ActionIcon(Icons.Outlined.ArrowBack, "返回设置", click = dismiss)
                Text(when(field) { CreationPicker.Project -> "选择项目"; CreationPicker.Harness -> "选择 Harness"; CreationPicker.Connection -> "账号与供应商"; CreationPicker.Model -> "选择模型"; CreationPicker.Team -> "协作团队" }, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (field == CreationPicker.Model) ActionIcon(Icons.Outlined.Refresh, "刷新模型", !state.catalogLoading, refresh)
                if (field == CreationPicker.Project) NTextButton(onClick = newProject) { Icon(Icons.Outlined.Add, null, Modifier.size(17.dp)); Text("新建项目", fontSize = 13.sp) }
            }
            if (field == CreationPicker.Model && state.catalogLoading) NProgress(Modifier.fillMaxWidth())
            LazyColumn(Modifier.weight(1f, fill = false).testTag("creation-choice-list"), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                if (choices.size > 6) item("search") {
                    NField(query, { query = it }, placeholder = { Text("搜索", fontSize = 14.sp, lineHeight = 20.sp) }, leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(18.dp)) }, singleLine = true, shape = RoundedCornerShape(15.dp), modifier = Modifier.fillMaxWidth())
                }
                items(choices.filter { it.second.contains(query, ignoreCase = true) }, key = { it.first }) { (id, title) ->
                    NPanel(onClick = { select(id) }, enabled = selectionEnabled, color = if (selected == id) Selection else Color.Transparent, shape = RoundedCornerShape(14.dp)) {
                        Row(Modifier.fillMaxWidth().heightIn(min = 49.dp).padding(horizontal = 13.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Icon(icon, null, Modifier.size(19.dp), tint = if (selected == id) Ink else ComposerSecondary)
                            Text(title, fontSize = 14.sp, lineHeight = 22.sp, fontWeight = if (selected == id) FontWeight.Medium else FontWeight.Normal, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            SelectionCheck(selected == id)
                        }
                    }
                }
                if (choices.isEmpty() && !state.catalogLoading) item { Text("使用电脑上的默认配置", Modifier.padding(16.dp), color = Secondary, fontSize = 14.sp) }
            }
            NTextButton(onClick = dismiss, modifier = Modifier.align(Alignment.End).testTag("creation-choice-cancel")) { Text("取消") }
        }
}
