package app.nautilo.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.*
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

@Composable fun InteractionCard(request: JSONObject, disabled: Boolean, model: MobileViewModel) {
    if (request.text("kind") == "question" && request.text("status") != "pending") {
        AnsweredQuestionCard(request)
        return
    }
    val selections = remember(request.text("id")) { mutableStateMapOf<String, Set<String>>() }
    val texts = remember(request.text("id")) { mutableStateMapOf<String, String>() }
    var submitting by remember(request.text("id")) { mutableStateOf(false) }
    val questions = request.objects("questions")
    val complete = questions.all { question -> question.optBoolean("allowEmpty") || selections[question.text("id")].orEmpty().isNotEmpty() || (texts[question.text("id")] ?: question.text("initialValue")).isNotBlank() }
    val cancel = { submitting = true; model.answer(request.text("id"), JSONObject(), cancelled = true, finished = { submitting = false }); Unit }
    val uri = LocalUriHandler.current
    var seconds by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(request.text("id")) {
        if (request.optLong("timeoutMs") > 0) {
            val deadline = runCatching { Instant.parse(request.text("createdAt")).toEpochMilli() + request.optLong("timeoutMs") }.getOrNull()
            while (deadline != null) { seconds = ((deadline - System.currentTimeMillis() + 999) / 1000).coerceAtLeast(0); kotlinx.coroutines.delay(1000) }
        }
    }
    NPanel(shape = RoundedCornerShape(22.dp), border = BorderStroke(1.dp, Line), color = Color.White) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.padding(start = 8.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (questions.size == 1) questions.first().text("question") else request.text("title", "需要你的回答"), Modifier.weight(1f).padding(top = 6.dp), fontSize = 16.sp, lineHeight = 25.sp, fontWeight = FontWeight.SemiBold)
                seconds?.let { Text("${it}秒", Modifier.padding(top = 7.dp).background(Color(0xFFF7F2E9), RoundedCornerShape(20.dp)).padding(horizontal = 7.dp, vertical = 2.dp), fontSize = 12.sp, color = Color(0xFFAA7829)) }
                NIconButton(cancel, enabled = !disabled && !submitting, modifier = Modifier.size(32.dp)) { Icon(Icons.Outlined.Close, "跳过", Modifier.size(16.dp), tint = Secondary) }
            }
            request.optJSONObject("plan")?.text("content")?.takeIf(String::isNotBlank)?.let { Markdown(it) }
            if (request.text("detail").isNotBlank()) Text(request.text("detail"), fontSize = 13.sp, lineHeight = 21.sp, color = Secondary)
            request.objects("links").forEach { link ->
                if (link.text("url").startsWith("https://")) NOutlinedButton({ uri.openUri(link.text("url")) }, enabled = !disabled) { Text(link.text("label", "打开授权页面")) }
            }
            questions.forEach { question -> key(question.text("id")) {
                val id = question.text("id")
                if (questions.size > 1) Text(question.text("question"), Modifier.padding(horizontal = 8.dp, vertical = 8.dp), fontSize = 15.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium)
                question.objects("options").forEachIndexed { index, option ->
                    val label = option.text("label")
                    val selected = label in selections[id].orEmpty()
                    NPanel(onClick = {
                        val current = selections[id].orEmpty()
                        selections[id] = if (question.optBoolean("multiSelect")) if (selected) current - label else current + label else setOf(label)
                        if (!question.optBoolean("multiSelect")) texts[id] = ""
                    }, enabled = !disabled && !submitting, color = if (selected) Selection else Color.White, shape = RoundedCornerShape(12.dp)) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                            NPanel(color = if (selected || index == 0) Ink else Selection, shape = RoundedCornerShape(6.dp)) {
                                Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { Text("${index + 1}", fontSize = 12.sp, color = if (selected || index == 0) Color.White else Secondary) }
                            }
                            Column(Modifier.weight(1f)) {
                                Text(label, fontSize = 15.sp, lineHeight = 23.sp, fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal)
                                option.text("description").takeIf(String::isNotBlank)?.let { Text(it, fontSize = 12.sp, lineHeight = 20.sp, color = Secondary) }
                            }
                            if (selected) Icon(Icons.Outlined.ArrowForward, null, Modifier.size(17.dp), tint = Secondary)
                        }
                    }
                }
                if (question.objects("options").isEmpty() || question.optBoolean("isOther")) QuestionInput(question, texts[id] ?: question.text("initialValue"), !disabled && !submitting) { value ->
                    texts[id] = value
                    if (!question.optBoolean("multiSelect") && value.isNotEmpty()) selections[id] = emptySet()
                }
            } }
            if (questions.isNotEmpty()) Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                NOutlinedButton(cancel, enabled = !disabled && !submitting, shape = RoundedCornerShape(24.dp)) { Text("跳过", fontSize = 13.sp) }
                NFilledIconButton(onClick = {
                submitting = true
                val answers = JSONObject()
                questions.forEach { q ->
                    val id = q.text("id")
                    val raw = texts[id] ?: q.text("initialValue")
                    val text = if (q.optBoolean("preserveWhitespace")) raw else raw.trim()
                    answers.put(id, JSONArray(selections[id].orEmpty().toList() + if (text.isNotEmpty() || q.optBoolean("allowEmpty") && q.objects("options").isEmpty()) listOf(text) else emptyList()))
                }
                model.answer(request.text("id"), answers, finished = { submitting = false })
            }, enabled = complete && !disabled && !submitting) { if (submitting) NSpinner(Modifier.size(15.dp), color = Color.White) else Icon(Icons.Outlined.ArrowUpward, "提交回答", Modifier.size(18.dp)) }
            }
            else request.objects("options").forEach { option ->
                NOutlinedButton(enabled = !disabled && !submitting, onClick = { submitting = true; model.answer(request.text("id"), JSONObject(), option.text("id"), finished = { submitting = false }) }, modifier = Modifier.fillMaxWidth()) { Text(option.text("label")) }
            }
        }
    }
}

@Composable private fun AnsweredQuestionCard(request: JSONObject) {
    val questions = request.objects("questions")
    NPanel(shape = RoundedCornerShape(22.dp), border = BorderStroke(1.dp, Line)) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (questions.size == 1) questions.first().text("question") else request.text("title", "需要你的回答"), fontSize = 16.sp, lineHeight = 25.sp, fontWeight = FontWeight.SemiBold)
            questions.forEach { question ->
                if (questions.size > 1) Text(question.text("question"), fontSize = 14.sp, lineHeight = 23.sp, fontWeight = FontWeight.Medium)
                val answer = request.optJSONObject("response")?.optJSONObject("answers")?.strings(question.text("id")).orEmpty()
                Text(if (answer.isEmpty()) "—" else "你的回答：${if (question.optBoolean("isSecret")) "••••••" else answer.joinToString("，")}", fontSize = 14.sp, lineHeight = 23.sp, color = Secondary)
            }
        }
    }
}

@Composable private fun QuestionInput(question: JSONObject, value: String, enabled: Boolean, update: (String) -> Unit) {
    val voice = rememberVoiceInput { update((value + " " + it).trim()) }
    Row(Modifier.fillMaxWidth().padding(start = 10.dp, top = 4.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(Icons.Outlined.Edit, null, Modifier.padding(top = 12.dp).size(17.dp), tint = Secondary)
        BasicTextField(value, update, enabled = enabled, modifier = Modifier.weight(1f).heightIn(min = 44.dp).padding(vertical = 10.dp),
            minLines = if (question.text("inputType") == "multiline") 3 else 1,
            textStyle = TextStyle(fontFamily = UiFont, fontSize = 15.sp, lineHeight = 25.sp, color = Ink), cursorBrush = SolidColor(Ink),
            visualTransformation = if (question.optBoolean("isSecret")) PasswordVisualTransformation() else VisualTransformation.None,
            decorationBox = { input -> Box { if (value.isEmpty()) Text(question.text("placeholder", if (question.objects("options").isEmpty()) "你的回答" else "或描述其他内容"), fontSize = 15.sp, lineHeight = 25.sp, color = Secondary.copy(alpha = .65f)); input() } })
        if (!question.optBoolean("isSecret")) NIconButton(voice, enabled = enabled) { Icon(Icons.Outlined.MicNone, "语音回答", Modifier.size(19.dp)) }
    }
}

@Composable fun ApprovalCard(request: JSONObject, disabled: Boolean, model: MobileViewModel, scopeSelection: Boolean = false) {
    var submitting by remember(request.text("id")) { mutableStateOf(false) }
    val kind = request.text("category", request.text("kind", "command"))
    val scopes = if (!scopeSelection) listOf("once") else request.strings("availableScopes").ifEmpty {
        if (kind != "command") listOf("once", "run", "task", "project", "global") else listOf("once", "run") +
            (if (request.text("taskId").isNotBlank()) listOf("task") else emptyList()) + (if (request.text("projectId").isNotBlank()) listOf("project") else emptyList()) + "global"
    }
    var scope by remember(request.text("id")) { mutableStateOf(if (kind == "merge") "project" else if (kind == "delegate") "run" else "once") }
    val selectedScope = scope.takeIf { it in scopes } ?: scopes.first()
    var menu by remember { mutableStateOf(false) }
    fun scopeLabel(value: String) = when (value) { "run" -> if (request.text("projectRunId").isNotBlank()) "本次运行" else "此会话"; "task" -> "此任务"; "project" -> "此项目"; "global" -> "始终允许"; else -> "仅本次" }
    val description = request.text("description", request.text("summary", request.text("reason", request.text("command", request.text("title", "运行请求")))))
    val title = if (kind == "command") description.replace(Regex("^Launch\\s+", RegexOption.IGNORE_CASE), "启动 ") else request.text("title", "运行审批")
    val resolve: (String) -> Unit = { decision ->
        if (!submitting) { submitting = true; model.approve(request.text("id"), decision, selectedScope) { submitting = false } }
    }
    NPanel(shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, Line), color = Color.White) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.VerifiedUser, null, Modifier.size(18.dp), tint = Accent)
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(title, fontSize = 15.sp, lineHeight = 23.sp, fontWeight = FontWeight.SemiBold)
                    Text("待批准", fontSize = 12.sp, color = Secondary)
                }
            }
            if (kind != "command" && description != title) Text(description, fontSize = 14.sp, lineHeight = 22.sp)
            request.optJSONObject("request")?.text("command")?.takeIf(String::isNotBlank)?.let { Text(it, fontSize = 13.sp, color = Secondary) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Box(Modifier.weight(1f)) {
                    NTextButton({ menu = true }, enabled = !disabled && !submitting && scopes.size > 1) {
                        Text(scopeLabel(selectedScope), fontSize = 12.sp)
                        if (scopes.size > 1) Icon(Icons.Outlined.ExpandMore, null, Modifier.padding(start = 4.dp).size(15.dp))
                    }
                    NMenu(menu, { menu = false }) { scopes.forEach { value -> NMenuItem({ Text(scopeLabel(value)) }, { scope = value; menu = false }) } }
                }
                NOutlinedButton(enabled = !disabled && !submitting, onClick = { resolve("rejected") }) { Text("拒绝") }
                Spacer(Modifier.width(8.dp))
                NButton(enabled = !disabled && !submitting, onClick = { resolve("approved") }) {
                    if (submitting) NSpinner(Modifier.size(14.dp), color = Color.White) else Icon(Icons.Outlined.Check, null, Modifier.size(16.dp))
                    Text("批准")
                }
            }
        }
    }
}
