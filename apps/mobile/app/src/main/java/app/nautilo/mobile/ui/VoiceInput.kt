package app.nautilo.mobile.ui

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.*
import androidx.compose.runtime.*
import java.util.Locale

@Composable fun rememberVoiceInput(onText: (String) -> Unit): () -> Unit {
    val receive by rememberUpdatedState(onText)
    var unavailable by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let(receive)
    }
    if (unavailable) AlertDialog(onDismissRequest = { unavailable = false }, title = { Text("语音输入不可用") }, text = { Text("此设备没有可用的语音识别服务，可以使用键盘的语音输入。") }, confirmButton = { TextButton(onClick = { unavailable = false }) { Text("知道了") } })
    return { runCatching { launcher.launch(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())) }.onFailure { unavailable = true }; Unit }
}
