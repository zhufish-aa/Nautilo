@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package app.nautilo.mobile.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import java.util.Locale

@Composable fun rememberVoiceInput(onText: (String) -> Unit): () -> Unit {
    val context = LocalContext.current
    val receive by rememberUpdatedState(onText)
    var recognizer by remember { mutableStateOf<SpeechRecognizer?>(null) }
    var listening by remember { mutableStateOf(false) }
    var partial by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    val cancel = { listening = false; recognizer?.cancel(); Unit }
    val start = {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) error = "此设备没有可用的语音识别服务，可以使用键盘的语音输入。"
        else try {
            val engine = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also { recognizer = it }
            engine.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = Unit
                override fun onBeginningOfSpeech() = Unit
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() = Unit
                override fun onEvent(eventType: Int, params: Bundle?) = Unit
                override fun onPartialResults(results: Bundle?) { partial = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty() }
                override fun onResults(results: Bundle?) {
                    if (listening) results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf(String::isNotBlank)?.let(receive)
                    listening = false
                }
                override fun onError(code: Int) {
                    if (listening) error = when (code) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没有听清，请再试一次。"
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "需要麦克风权限才能使用语音输入。"
                        else -> "语音识别暂时不可用，请稍后再试。"
                    }
                    listening = false
                }
            })
            partial = ""; listening = true
            engine.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true))
        } catch (_: Exception) { listening = false; error = "语音输入暂时不可用。" }
        Unit
    }
    val currentStart by rememberUpdatedState(start)
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) currentStart() else error = "需要麦克风权限才能使用语音输入。"
    }
    DisposableEffect(Unit) { onDispose { recognizer?.destroy() } }
    if (listening) NSheet(onDismissRequest = cancel) {
        Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Icon(Icons.Outlined.MicNone, null, Modifier.size(30.dp))
            Text("正在聆听", fontSize = 20.sp)
            Text(partial.ifBlank { "说点什么…" }, fontSize = 17.sp, lineHeight = 28.sp, color = Secondary, modifier = Modifier.heightIn(min = 80.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                NTextButton(cancel) { Text("取消") }
                NButton({ recognizer?.stopListening() }) { Text("完成") }
            }
        }
    }
    if (error.isNotEmpty()) NAlert({ error = "" }, title = { Text("语音输入") }, text = { Text(error) }, confirmButton = { NTextButton({ error = "" }) { Text("知道了") } })
    return { if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) start() else permission.launch(Manifest.permission.RECORD_AUDIO) }
}
