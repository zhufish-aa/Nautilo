@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package app.nautilo.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.Screen
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

@Composable fun NautiloApp(model: MobileViewModel, invitation: String?, consumed: () -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    var pairSheet by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var link by remember { mutableStateOf("") }
    val scan = rememberLauncherForActivityResult(ScanContract()) { result -> result.contents?.let(model::pair) }
    LaunchedEffect(invitation) { invitation?.let { model.pair(it); consumed() } }
    val backTarget = when (state.screen) { Screen.FileDiff -> Screen.Workspace; Screen.Workspace -> Screen.Chat; else -> Screen.Projects }
    BackHandler(state.screen != Screen.Projects) { model.navigate(backTarget) }
    NautiloTheme {
        Column(Modifier.fillMaxSize().background(if (state.screen == Screen.NewConversation) WelcomeBackdrop else Backdrop).statusBarsPadding().navigationBarsPadding()) {
            if (state.screen != Screen.NewConversation) {
            Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                ActionIcon(if (state.screen == Screen.Projects) Icons.Outlined.Menu else Icons.Outlined.ArrowBack, "返回") {
                    if (state.screen == Screen.Projects) model.navigate(Screen.Computers)
                    else model.navigate(backTarget)
                }
                Column(Modifier.weight(1f).padding(start = 4.dp)) {
                    Text(when (state.screen) {
                        Screen.Projects -> "Nautilo"
                        Screen.Chat -> state.session?.title ?: "会话"
                        Screen.Workspace -> (state.projects.find { it.id == state.session?.projectId }?.name ?: "项目") + " 工作区"
                        Screen.FileDiff -> "文件变更"
                        Screen.Computers -> "电脑连接"
                        Screen.NewConversation -> "新会话"
                    }, fontSize = if (state.screen == Screen.Projects) 23.sp else 17.sp, fontWeight = if (state.screen == Screen.Projects) FontWeight.Medium else FontWeight.SemiBold,
                        maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                    if (state.screen == Screen.Chat || state.screen == Screen.Workspace) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        Dot(state.connected)
                        Text((state.projects.find { it.id == state.session?.projectId }?.name ?: "") + " · " + if (state.connected) "已连接电脑" else "正在重连", fontSize = 11.sp, color = Secondary)
                    }
                }
                when (state.screen) {
                    Screen.Projects -> {
                        ActionIcon(Icons.Outlined.Search, "搜索会话") { menu = true }
                        ActionIcon(Icons.Outlined.Add, "新建会话") { if (state.host == null) pairSheet = true else model.beginConversation() }
                    }
                    Screen.Chat -> ActionIcon(Icons.Outlined.Workspaces, "工作区") { model.workspace() }
                    else -> {}
                }
                if (state.screen != Screen.Projects) Box {
                    ActionIcon(Icons.Outlined.MoreHoriz, "更多") { menu = true }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("电脑连接") }, onClick = { menu = false; model.navigate(Screen.Computers) }, leadingIcon = { Icon(Icons.Outlined.Computer, null) })
                        DropdownMenuItem(text = { Text("重新连接") }, onClick = { menu = false; model.retry() }, leadingIcon = { Icon(Icons.Outlined.Refresh, null) })
                    }
                }
            }
            }
            AnimatedVisibility(state.error.isNotEmpty(), enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Info, null, Modifier.size(16.dp), tint = Danger)
                    Text(state.error, color = Danger, fontSize = 12.sp, lineHeight = 18.sp, modifier = Modifier.weight(1f).padding(horizontal = 8.dp))
                    ActionIcon(Icons.Outlined.Close, "收起提示") { model.clearError() }
                }
            }
            AnimatedContent(state.screen, modifier = Modifier.weight(1f), transitionSpec = {
                (fadeIn(tween(220)) + slideInHorizontally(tween(260)) { it / 12 }).togetherWith(fadeOut(tween(120)))
            }, label = "page") { screen ->
                when (screen) {
                    Screen.Projects -> ProjectsScreen(state, model, menu, { menu = false }, { pairSheet = true })
                    Screen.NewConversation -> NewConversationScreen(state, model)
                    Screen.Chat -> ChatScreen(state, model)
                    Screen.Workspace -> WorkspaceScreen(state, model)
                    Screen.FileDiff -> FileDiffScreen(state, model)
                    Screen.Computers -> ComputersScreen(state, model) { pairSheet = true }
                }
            }
        }
        if (pairSheet) ModalBottomSheet(onDismissRequest = { pairSheet = false }, containerColor = androidx.compose.ui.graphics.Color.White) {
            Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                Text("连接电脑", style = MaterialTheme.typography.titleLarge)
                Text("在电脑 Nautilo 的远程连接设置中生成配对码", color = Secondary, fontSize = 14.sp)
                Button(onClick = { pairSheet = false; scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("扫描电脑上的 Nautilo 配对码").setBeepEnabled(false).setOrientationLocked(false)) }, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                    Icon(Icons.Outlined.QrCodeScanner, null); Spacer(Modifier.width(10.dp)); Text("扫描二维码")
                }
                OutlinedTextField(value = link, onValueChange = { link = it }, label = { Text("或粘贴配对链接") }, modifier = Modifier.fillMaxWidth(), maxLines = 3)
                TextButton(onClick = { pairSheet = false; model.pair(link) }, enabled = link.isNotBlank(), modifier = Modifier.align(Alignment.End)) { Text("使用链接连接") }
            }
        }
    }
}
