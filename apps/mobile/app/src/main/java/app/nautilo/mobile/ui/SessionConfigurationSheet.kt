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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.*

@Composable fun SessionConfigurationSheet(state: MobileState, model: MobileViewModel, close: () -> Unit) {
    val session = state.session ?: return
    var selectedConnection by remember(session.id) { mutableStateOf(session.connectionId) }
    var selectedModel by remember(session.id) { mutableStateOf(session.model) }
    var selectedEffort by remember(session.id) { mutableStateOf(session.effort) }
    var chooseConnection by remember { mutableStateOf(false) }
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
    val maxHeight = LocalConfiguration.current.screenHeightDp.dp * .84f
    LaunchedEffect(Unit) { model.clearError(); model.loadSetup(); model.loadModels() }
    LaunchedEffect(catalog) {
        if (catalog.isNotEmpty() && chosen == null) catalog.first().let {
            selectedModel = it.text("id"); selectedEffort = it.text("defaultReasoningEffort")
        }
    }
    val applySwitch = {
        model.configure(selectedModel, selectedEffort, selectedConnection, confirmChange = true, configured = close)
    }
    ModalBottomSheet(onDismissRequest = { if (!state.changing) close() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Color(0xFFFCFDFE)) {
        Column(Modifier.fillMaxWidth().heightIn(max = maxHeight).padding(horizontal = 20.dp).padding(bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("模型与连接", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                ActionIcon(Icons.Outlined.Refresh, "刷新模型", !loading && !state.changing) {
                    if (switching) model.loadNewModels(session.agentId, selectedConnection, refresh = true) else model.loadModels(refresh = true)
                }
            }
            Surface(onClick = { chooseConnection = true }, enabled = editable, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, Line), color = Color.White) {
                Row(Modifier.fillMaxWidth().padding(15.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(if (connection?.text("kind") == "api") Icons.Outlined.Dns else Icons.Outlined.PersonOutline, null, Modifier.size(21.dp), tint = Blue)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(connection?.text("name") ?: "Harness 原生配置", fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (switching) "待切换连接" else "当前连接", fontSize = 11.sp, color = Secondary)
                    }
                    Icon(Icons.Outlined.UnfoldMore, "切换账号或 API", Modifier.size(18.dp), tint = Secondary)
                }
            }
            if (active) Text("当前轮结束后可切换账号、API 和模型", fontSize = 12.sp, color = Secondary)
            if (catalog.size > 6) OutlinedTextField(query, { query = it }, placeholder = { Text("搜索模型", fontSize = 14.sp) }, leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(18.dp)) }, shape = RoundedCornerShape(14.dp), singleLine = true, modifier = Modifier.fillMaxWidth())
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            LazyColumn(Modifier.weight(1f, fill = false).heightIn(max = 360.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                items(catalog.filter { it.text("displayName", it.text("id")).contains(query, true) }, key = { it.text("id") }) { item ->
                    val selected = item.text("id") == selectedModel
                    Surface(onClick = {
                        selectedModel = item.text("id")
                        selectedEffort = item.text("defaultReasoningEffort", item.strings("reasoningEfforts").firstOrNull().orEmpty())
                        if (!switching) model.configure(selectedModel, selectedEffort, configured = close)
                    }, enabled = editable && !loading, shape = RoundedCornerShape(13.dp), color = if (selected) Selection else Color.Transparent) {
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Icon(Icons.Outlined.Layers, null, Modifier.size(18.dp), tint = if (selected) Blue else Secondary)
                            Text(item.text("displayName", item.text("id")), fontSize = 14.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (selected) Icon(Icons.Outlined.Check, null, Modifier.size(17.dp), tint = Blue)
                        }
                    }
                }
                if (catalog.isEmpty() && !loading) item { Text("尚未取得模型，请点击右上角刷新", Modifier.padding(vertical = 16.dp), fontSize = 13.sp, color = Secondary) }
            }
            if (efforts.isNotEmpty()) {
                Surface(color = Color(0xFFF0F5F9), shape = RoundedCornerShape(18.dp)) {
                    Column(Modifier.fillMaxWidth().padding(13.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                            Icon(Icons.Outlined.Psychology, null, Modifier.size(17.dp), tint = Blue)
                            Text("推理强度", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        }
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            efforts.forEach { value -> Surface(onClick = { selectedEffort = value; if (!switching) model.configure(selectedModel, value, configured = close) },
                                enabled = editable && !loading, color = if (value == selectedEffort) Ink else Color.White, shape = RoundedCornerShape(11.dp)) {
                                Text(effortName(value), Modifier.padding(horizontal = 14.dp, vertical = 11.dp), fontSize = 12.sp, color = if (value == selectedEffort) Color.White else Ink)
                            } }
                        }
                    }
                }
            }
            if (state.error.isNotBlank()) Text(state.error, fontSize = 13.sp, color = Danger)
            if (switching) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { selectedConnection = session.connectionId; selectedModel = session.model; selectedEffort = session.effort }, enabled = !state.changing) { Text("取消切换") }
                Spacer(Modifier.weight(1f))
                Button(onClick = {
                    if (state.messages.isNotEmpty() || state.runs.isNotEmpty()) confirmSwitch = true else applySwitch()
                }, enabled = editable && !loading && chosen != null, shape = RoundedCornerShape(13.dp)) {
                    if (state.changing) CircularProgressIndicator(Modifier.size(17.dp), strokeWidth = 2.dp, color = Color.White)
                    else Text("切换并应用", color = Color.White)
                }
            }
        }
    }
    if (chooseConnection) CreationChoiceSheet(CreationPicker.Connection, state, session.projectId, session.agentId, selectedConnection, selectedModel, selectedEffort,
        refresh = {}, newProject = {}, dismiss = { chooseConnection = false }) { id ->
            chooseConnection = false
            if (id != selectedConnection) {
                selectedConnection = id; query = ""
                if (id != session.connectionId) model.loadNewModels(session.agentId, id)
                else { selectedModel = session.model; selectedEffort = session.effort }
            }
        }
    if (confirmSwitch) AlertDialog(onDismissRequest = { confirmSwitch = false }, title = { Text("切换到 ${connection?.text("name") ?: "原生配置"}？") },
        text = { Text("文字记录会保留。更换连接将重建原生会话，旧推理、缓存和图片上下文不会迁移。") },
        confirmButton = { TextButton(onClick = { confirmSwitch = false; applySwitch() }) { Text("切换连接") } },
        dismissButton = { TextButton(onClick = { confirmSwitch = false }) { Text("取消") } })
}
