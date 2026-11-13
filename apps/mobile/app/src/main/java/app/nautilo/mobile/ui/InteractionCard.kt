package app.nautilo.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.MobileViewModel
import app.nautilo.mobile.data.*
import org.json.JSONArray
import org.json.JSONObject

@Composable fun InteractionCard(request: JSONObject, disabled: Boolean, model: MobileViewModel) {
    val selections = remember(request.text("id")) { mutableStateMapOf<String, Set<String>>() }
    val texts = remember(request.text("id")) { mutableStateMapOf<String, String>() }
    var submitting by remember { mutableStateOf(false) }
    val questions = request.objects("questions")
    val complete = questions.all { question -> question.optBoolean("allowEmpty") || selections[question.text("id")].orEmpty().isNotEmpty() || (texts[question.text("id")] ?: question.text("initialValue")).isNotBlank() }
    Surface(shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, Line), color = Color.White) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.QuestionAnswer, null, Modifier.size(18.dp), tint = Blue)
                Text(request.text("title", "需要你的回答"), fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            }
            request.optJSONObject("plan")?.text("content")?.takeIf(String::isNotBlank)?.let { Markdown(it) }
            if (request.text("detail").isNotBlank()) Text(request.text("detail"), fontSize = 13.sp, lineHeight = 21.sp, color = Secondary)
            questions.forEach { question ->
                val id = question.text("id")
                Text(question.text("question"), fontSize = 14.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium)
                question.objects("options").forEach { option ->
                    val label = option.text("label")
                    val selected = label in selections[id].orEmpty()
                    Surface(onClick = {
                        val current = selections[id].orEmpty()
                        selections[id] = if (question.optBoolean("multiSelect")) if (selected) current - label else current + label else setOf(label)
                    }, enabled = !disabled && !submitting, color = if (selected) Selection else Color(0xFFF5F8FA), shape = RoundedCornerShape(12.dp)) {
                        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(if (selected) Icons.Outlined.CheckCircle else Icons.Outlined.RadioButtonUnchecked, null, Modifier.size(18.dp), tint = if (selected) Blue else Secondary)
                            Column(Modifier.weight(1f).padding(start = 10.dp)) {
                                Text(label, fontSize = 14.sp)
                                option.text("description").takeIf(String::isNotBlank)?.let { Text(it, fontSize = 12.sp, lineHeight = 19.sp, color = Secondary) }
                            }
                        }
                    }
                }
                OutlinedTextField(value = texts[id] ?: question.text("initialValue"), onValueChange = { texts[id] = it }, enabled = !disabled && !submitting,
                    label = { Text(if (question.objects("options").isEmpty()) question.text("placeholder", "你的回答") else "补充回答（可选）", fontSize = 12.sp) },
                    visualTransformation = if (question.optBoolean("isSecret")) PasswordVisualTransformation() else VisualTransformation.None,
                    modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp), minLines = if (question.text("inputType") == "multiline") 3 else 1)
            }
            if (questions.isNotEmpty()) Button(onClick = {
                submitting = true
                val answers = JSONObject()
                questions.forEach { q ->
                    val id = q.text("id")
                    val raw = texts[id] ?: q.text("initialValue")
                    val text = if (q.optBoolean("preserveWhitespace")) raw else raw.trim()
                    answers.put(id, JSONArray(selections[id].orEmpty().toList() + if (text.isNotEmpty() || q.optBoolean("allowEmpty")) listOf(text) else emptyList()))
                }
                model.answer(request.text("id"), answers)
            }, enabled = complete && !disabled && !submitting, modifier = Modifier.align(Alignment.End)) { Text(if (submitting) "正在提交" else "提交回答") }
            else request.objects("options").forEach { option ->
                OutlinedButton(enabled = !disabled && !submitting, onClick = { submitting = true; model.answer(request.text("id"), JSONObject(), option.text("id")) }, modifier = Modifier.fillMaxWidth()) { Text(option.text("label")) }
            }
            if (submitting) TextButton(onClick = { submitting = false }) { Text("提交未完成？重新尝试", fontSize = 12.sp) }
        }
    }
}

@Composable fun ApprovalCard(request: JSONObject, disabled: Boolean, model: MobileViewModel) {
    var submitting by remember { mutableStateOf(false) }
    Surface(shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, Line), color = Color.White) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.VerifiedUser, null, Modifier.size(18.dp), tint = Blue)
                Text("等待批准", fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            }
            Text(request.text("summary", request.text("reason", request.text("command", request.text("title", "运行请求")))), fontSize = 14.sp, lineHeight = 22.sp)
            request.optJSONObject("request")?.text("command")?.takeIf(String::isNotBlank)?.let { Text(it, fontSize = 13.sp, color = Secondary) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(enabled = !disabled && !submitting, onClick = { submitting = true; model.approve(request.text("id"), "rejected") }) { Text("拒绝", color = Danger) }
                Spacer(Modifier.width(8.dp))
                Button(enabled = !disabled && !submitting, onClick = { submitting = true; model.approve(request.text("id"), "approved") }) { Text("仅本次批准") }
            }
            if (submitting) TextButton(onClick = { submitting = false }) { Text("提交未完成？重新尝试", fontSize = 12.sp) }
        }
    }
}
