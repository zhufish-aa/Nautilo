@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.*

@Composable fun SessionConfigurationSheet(state: MobileState, model: MobileViewModel, close: () -> Unit) {
    SessionConfigurationEditor(state, model, close) { content ->
        NSheet(onDismissRequest = { if (!state.changing) close() }, containerColor = Color.White) { content() }
    }
}

@Composable internal fun SessionConfigurationEditor(state: MobileState, model: MobileViewModel, close: () -> Unit,
    container: @Composable (@Composable () -> Unit) -> Unit) {
    val session = state.session ?: return
    var selectedConnection by remember(session.id) { mutableStateOf(session.connectionId) }
    var selectedModel by remember(session.id) { mutableStateOf(session.model) }
    var selectedEffort by remember(session.id) { mutableStateOf(session.effort) }
    var selectedTeam by remember(session.id) { mutableStateOf(session.teamId) }
    var chooseConnection by remember { mutableStateOf(false) }
    var chooseTeam by remember { mutableStateOf(false) }
    var confirmSwitch by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val switching = selectedConnection != session.connectionId
    val catalog = if (switching) state.newModels else state.models
    val loading = if (switching) state.catalogLoading else state.modelsLoading
    val connection = state.setup.objects("connections").find { it.text("id") == selectedConnection }
    val chosen = catalog.find { it.text("id") == selectedModel }
    val efforts = chosen?.strings("reasoningEfforts").orEmpty()
    val active = running(state.runStatus)
    val editable = state.connected && !state.changing && !active
    val teamChanged = selectedTeam != session.teamId
    val modelChanged = switching || selectedModel != session.model || selectedEffort != session.effort
    LaunchedEffect(session.id) {
        model.clearError()
        if (state.setup.length() == 0) model.loadSetup()
        if (state.models.isEmpty()) model.loadModels()
    }
    LaunchedEffect(catalog) {
        if (catalog.isNotEmpty() && chosen == null) catalog.first().let {
            selectedModel = it.text("id"); selectedEffort = it.text("defaultReasoningEffort").ifBlank { it.strings("reasoningEfforts").firstOrNull().orEmpty() }
        }
    }
    val applySwitch = {
        model.configure(selectedModel, selectedEffort, selectedConnection, confirmChange = true,
            teamId = selectedTeam.takeIf { teamChanged }, configured = close)
    }
    val teamChoice: @Composable () -> Unit = {
        NPanel(onClick = { chooseTeam = true }, enabled = editable && session.parentSessionId.isEmpty() && "session.team" in state.capabilities,
            shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, Line), color = Color.White,
            modifier = Modifier.testTag("session-config-team")) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 15.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Outlined.Groups, null, Modifier.size(21.dp), tint = Ink)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("协作团队", fontSize = 11.sp, lineHeight = 16.sp, color = ComposerSecondary)
                    Text(teamSelectionName(selectedTeam, state), fontSize = 14.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium)
                }
                Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = Ink)
            }
        }
    }
    val connectionChoice: @Composable () -> Unit = {
        NPanel(onClick = { chooseConnection = true }, enabled = editable, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, Line), color = Color.White) {
            Row(Modifier.fillMaxWidth().padding(15.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(if (connection?.text("kind") == "api") Icons.Outlined.Dns else Icons.Outlined.PersonOutline, null, Modifier.size(21.dp), tint = Ink)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(connection?.text("name") ?: "Harness 原生配置", fontSize = 14.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(if (switching) "待切换连接" else "当前连接", fontSize = 11.sp, lineHeight = 16.sp, color = Secondary)
                }
                Icon(Icons.Outlined.UnfoldMore, "切换账号或 API", Modifier.size(18.dp), tint = Secondary)
            }
        }
    }
    val search: @Composable () -> Unit = {
        if (catalog.size > 6) NField(query, { query = it }, placeholder = { Text("搜索模型", fontSize = 14.sp, lineHeight = 20.sp) }, leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(18.dp)) }, shape = RoundedCornerShape(14.dp), singleLine = true, modifier = Modifier.fillMaxWidth())
    }
    val effortChoices: @Composable () -> Unit = {
        if (efforts.isNotEmpty()) {
            NPanel(color = Color(0xFFF6F6F6), shape = RoundedCornerShape(18.dp)) {
                Column(Modifier.fillMaxWidth().padding(13.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                        Icon(Icons.Outlined.Psychology, null, Modifier.size(17.dp), tint = Ink)
                        Text("推理强度", fontSize = 13.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium)
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        efforts.forEach { value -> NPanel(onClick = { selectedEffort = value },
                            modifier = Modifier.heightIn(min = 44.dp),
                            enabled = editable && !loading, color = if (value == selectedEffort) Ink else Color.White, shape = RoundedCornerShape(11.dp)) {
                            Text(effortName(value), Modifier.padding(horizontal = 14.dp, vertical = 11.dp), fontSize = 14.sp, lineHeight = 20.sp, color = if (value == selectedEffort) Color.White else Ink)
                        } }
                    }
                }
            }
        }
    }
    val modelRow: @Composable (org.json.JSONObject) -> Unit = { item ->
        val selected = item.text("id") == selectedModel
        NPanel(onClick = {
            selectedModel = item.text("id")
            selectedEffort = item.text("defaultReasoningEffort", item.strings("reasoningEfforts").firstOrNull().orEmpty())
        }, enabled = editable && !loading, shape = RoundedCornerShape(13.dp), color = if (selected) Selection else Color.Transparent) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Outlined.Layers, null, Modifier.size(18.dp), tint = if (selected) Ink else ComposerSecondary)
                Text(item.text("displayName", item.text("id")), fontSize = 16.sp, lineHeight = 24.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                SelectionCheck(selected)
            }
        }
    }
    container {
      MotionPage(if (chooseTeam) "teams" else if (chooseConnection) "connections" else "models") {
      if (chooseTeam) TeamChoiceContent(state, selectedTeam, model::loadSetup, { chooseTeam = false }) { selectedTeam = it; chooseTeam = false }
      else if (chooseConnection) CreationChoiceContent(CreationPicker.Connection, state, session.projectId, session.agentId, selectedConnection, selectedModel, selectedEffort,
        refresh = {}, newProject = {}, dismiss = { chooseConnection = false }) { id ->
            chooseConnection = false
            if (id != selectedConnection) {
                selectedConnection = id; query = ""
                if (id != session.connectionId) model.loadNewModels(session.agentId, id)
                else { selectedModel = session.model; selectedEffort = session.effort }
            }
        }
      else {
      BoxWithConstraints(Modifier.fillMaxWidth().fillMaxHeight()) {
        val compact = maxHeight < 540.dp || LocalDensity.current.fontScale > 1.25f
        val visibleModels = catalog.filter { it.text("displayName", it.text("id")).contains(query, true) }
        Column(Modifier.fillMaxSize().padding(horizontal = 20.dp).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("模型与设置", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                ActionIcon(Icons.Outlined.Refresh, "刷新模型", !loading && !state.changing) {
                    if (switching) model.loadNewModels(session.agentId, selectedConnection, refresh = true) else model.loadModels(refresh = true)
                }
            }
            if (!compact) {
                connectionChoice()
                teamChoice()
                if (active) Text("当前轮结束后可切换账号、API 和模型", fontSize = 12.sp, color = Secondary)
                search()
            }
            if (loading) NProgress(Modifier.fillMaxWidth())
            LazyColumn(Modifier.weight(1f).testTag("session-config-models"), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                if (compact) {
                    item { connectionChoice(); Spacer(Modifier.height(12.dp)) }
                    item { teamChoice(); Spacer(Modifier.height(12.dp)) }
                    if (active) item { Text("当前轮结束后可切换账号、API 和模型", fontSize = 12.sp, color = Secondary) }
                    item { search(); Spacer(Modifier.height(12.dp)) }
                }
                items(visibleModels, key = { it.text("id") }) { modelRow(it) }
                if (catalog.isEmpty() && !loading) item { Text("尚未取得模型，请点击右上角刷新", Modifier.padding(vertical = 16.dp), fontSize = 13.sp, color = Secondary) }
                if (compact) {
                    item { Spacer(Modifier.height(12.dp)); effortChoices() }
                    if (state.error.isNotBlank()) item { Text(state.error, fontSize = 13.sp, color = Danger) }
                }
            }
            if (!compact) {
                effortChoices()
                if (state.error.isNotBlank()) Text(state.error, fontSize = 13.sp, color = Danger)
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                NTextButton(onClick = close, enabled = !state.changing, modifier = Modifier.testTag("session-config-cancel")) { Text("取消") }
                Spacer(Modifier.weight(1f))
                val changed = modelChanged || teamChanged
                NButton(onClick = {
                    if (!changed) close()
                    else if (switching && (state.messages.isNotEmpty() || state.runs.isNotEmpty())) confirmSwitch = true
                    else model.configure(selectedModel, selectedEffort, if (switching) selectedConnection else null, confirmChange = switching,
                        teamId = selectedTeam.takeIf { teamChanged }, configured = close)
                }, enabled = !state.changing && (!changed || (editable && (!modelChanged || (!loading && chosen != null)))), modifier = Modifier.testTag("session-config-apply"), shape = RoundedCornerShape(12.dp)) {
                    if (state.changing) { NSpinner(Modifier.size(16.dp), strokeWidth = 1.6.dp, color = Color.White); Text(" 正在应用…") }
                    else Text("完成")
                }
            }
        }
      }
      }
    }
    }
    if (confirmSwitch) NAlert(onDismissRequest = { confirmSwitch = false }, title = { Text("切换连接？") },
        text = { Text("聊天记录会保留。更换连接会重新建立会话，之前的推理、缓存和图片上下文不会迁移。") },
        confirmButton = { NButton(onClick = { confirmSwitch = false; applySwitch() }) { Text("切换连接") } },
        dismissButton = { NTextButton(onClick = { confirmSwitch = false }) { Text("取消") } })
}
