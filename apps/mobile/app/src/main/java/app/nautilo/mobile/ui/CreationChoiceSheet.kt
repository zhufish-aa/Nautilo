@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package app.nautilo.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
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
    val modelPicker = field == CreationPicker.Model
    val choices = when (field) {
        CreationPicker.Project -> state.projects.map { it.id to it.name }
        CreationPicker.Harness -> state.setup.objects("agents").map { it.text("id") to it.text("name") }
        CreationPicker.Connection -> listOf("" to "使用 Harness 原生配置") + state.setup.objects("connections").map { it.text("id") to it.text("name") }
        CreationPicker.Model -> state.newModels.map { it.text("id") to it.text("displayName", it.text("id")) }
        CreationPicker.Team -> emptyList()
    }
    val visibleChoices = choices.filter { (id, title) ->
        title.contains(query, ignoreCase = true) || (modelPicker && id.contains(query, ignoreCase = true))
    }
    val icon = when(field) { CreationPicker.Project -> Icons.Outlined.FolderOpen; CreationPicker.Harness -> Icons.Outlined.ViewInAr; CreationPicker.Connection -> Icons.Outlined.PersonOutline; CreationPicker.Model -> Icons.Outlined.Layers; CreationPicker.Team -> Icons.Outlined.Groups }
        Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).padding(horizontal = 20.dp).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ActionIcon(Icons.Outlined.ArrowBack, "返回设置", click = dismiss)
                Text(when(field) { CreationPicker.Project -> "选择项目"; CreationPicker.Harness -> "选择 Harness"; CreationPicker.Connection -> "账号与供应商"; CreationPicker.Model -> "选择模型"; CreationPicker.Team -> "协作团队" }, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (modelPicker) ActionIcon(Icons.Outlined.Refresh, "刷新模型", !state.catalogLoading, refresh)
                if (field == CreationPicker.Project) NTextButton(onClick = newProject) { Icon(Icons.Outlined.Add, null, Modifier.size(17.dp)); Text("新建项目", fontSize = 13.sp) }
            }
            if (modelPicker && state.catalogLoading) NProgress(Modifier.fillMaxWidth())
            if (choices.size > 6 || query.isNotBlank()) NField(query, { query = it },
                placeholder = { Text(if (modelPicker) "搜索模型" else "搜索", fontSize = 14.sp, lineHeight = 20.sp) },
                leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(17.dp), tint = Secondary) },
                singleLine = true, shape = RoundedCornerShape(11.dp), modifier = Modifier.fillMaxWidth())
            LazyColumn(Modifier.weight(1f, fill = false).fillMaxWidth().testTag("creation-choice-list"),
                verticalArrangement = Arrangement.spacedBy(if (modelPicker) 0.dp else 3.dp)) {
                itemsIndexed(visibleChoices, key = { _, choice -> choice.first }) { index, (id, title) ->
                    val current = selected == id
                    if (modelPicker && index > 0 && !current && visibleChoices[index - 1].first != selected) {
                        NDivider(Modifier.padding(start = 36.dp, end = 12.dp))
                    }
                    NPanel(onClick = { select(id) }, enabled = selectionEnabled,
                        color = if (current) Selection else Color.Transparent, shape = RoundedCornerShape(if (modelPicker) 9.dp else 14.dp),
                        border = if (modelPicker && current) BorderStroke(1.dp, Accent.copy(alpha = .30f)) else null) {
                        Row(Modifier.fillMaxWidth().heightIn(min = if (modelPicker) 44.dp else 49.dp)
                            .padding(horizontal = 12.dp, vertical = if (modelPicker) 4.dp else 12.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Icon(icon, null, Modifier.size(if (modelPicker) 16.dp else 19.dp),
                                tint = if (modelPicker && current) MobilePalette.brightAccent else Secondary)
                            Text(title, color = Ink, fontSize = 14.sp, lineHeight = 20.sp,
                                fontWeight = if (current) FontWeight.Medium else FontWeight.Normal,
                                modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            SelectionCheck(current)
                        }
                    }
                }
                if (choices.isEmpty() && !state.catalogLoading) item { Text("使用电脑上的默认配置", Modifier.padding(16.dp), color = Secondary, fontSize = 14.sp) }
                if (choices.isNotEmpty() && visibleChoices.isEmpty()) item {
                    Text("没有匹配的结果", Modifier.padding(16.dp), color = Secondary, fontSize = 14.sp)
                }
            }
            NTextButton(onClick = dismiss, modifier = Modifier.align(Alignment.End).testTag("creation-choice-cancel")) { Text("取消") }
        }
}
