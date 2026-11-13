package app.nautilo.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileState
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.Host

@Composable fun ComputersScreen(state: MobileState, model: MobileViewModel, pair: () -> Unit) {
    var remove by remember { mutableStateOf<Host?>(null) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (state.pairing) item {
            Surface(shape = RoundedCornerShape(20.dp), color = Color.White) {
                Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    Text("在电脑上确认连接", style = MaterialTheme.typography.titleLarge)
                    Text("确认两端显示的数字相同", color = Secondary)
                    Text(state.pairingCode.ifEmpty { "··· ···" }.chunked(3).joinToString("  "), fontSize = 36.sp, fontWeight = FontWeight.Medium, color = Blue)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 1.8.dp)
                        Text("等待电脑确认", Modifier.padding(start = 10.dp), color = Secondary, fontSize = 13.sp)
                        Spacer(Modifier.weight(1f))
                        TextButton(onClick = model::cancelPairing) { Text("取消") }
                    }
                }
            }
        }
        items(state.hosts, key = { it.id }) { host ->
            val current = host.id == state.host?.id
            Surface(shape = RoundedCornerShape(24.dp), color = Color.White, border = BorderStroke(1.dp, Line)) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(48.dp).background(Selection.copy(alpha = .6f), RoundedCornerShape(15.dp)), contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.DesktopWindows, null, Modifier.size(26.dp), tint = Blue)
                        }
                        Column(Modifier.weight(1f).padding(start = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(host.name, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Dot(current && state.connected)
                                Text(if (current && state.connected) "已连接" else if (current && state.connecting) "正在连接" else "已配对", fontSize = 13.sp, color = Secondary)
                            }
                        }
                        ActionIcon(Icons.Outlined.LinkOff, "移除配对") { remove = host }
                    }
                    if (current) Surface(shape = RoundedCornerShape(16.dp), color = Color(0xFFF3F7FA)) {
                        Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            InfoRow("系统", state.system.let { when(it) { "macos" -> "macOS"; "windows" -> "Windows"; "linux" -> "Linux"; else -> "—" } })
                            InfoRow("连接", if (state.connected) when(state.path) { "direct" -> "P2P 直连"; "relay" -> "加密中继"; "mixed" -> "直连 / 中继"; else -> "端到端加密" } else "未连接")
                            state.latency?.let { InfoRow("往返延迟", "$it ms") }
                            InfoRow("工作区", "全部项目 · ${state.projects.size} 个")
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = { if (current) model.retry() else model.selectHost(host) }) { Text(if (current) "重新连接" else "连接这台电脑") }
                    }
                }
            }
        }
        item {
            Surface(onClick = pair, shape = RoundedCornerShape(18.dp), color = Color.White, border = BorderStroke(1.dp, Line)) {
                Row(Modifier.fillMaxWidth().padding(19.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Add, null, Modifier.size(23.dp))
                    Text(if (state.hosts.isEmpty()) "连接我的电脑" else "连接另一台电脑", Modifier.weight(1f).padding(start = 16.dp), fontSize = 15.sp)
                    Icon(Icons.Outlined.ChevronRight, null, Modifier.size(19.dp), tint = Secondary)
                }
            }
        }
    }
    remove?.let { host -> AlertDialog(onDismissRequest = { remove = null }, title = { Text("移除这台电脑？") }, text = { Text("手机上的配对信息将被移除，电脑上的会话和任务会保留。") },
        confirmButton = { TextButton(onClick = { model.removeHost(host); remove = null }) { Text("移除", color = Danger) } },
        dismissButton = { TextButton(onClick = { remove = null }) { Text("取消") } }) }
}

@Composable private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth()) { Text(label, Modifier.width(84.dp), fontSize = 13.sp, color = Secondary); Text(value, fontSize = 13.sp) }
}
