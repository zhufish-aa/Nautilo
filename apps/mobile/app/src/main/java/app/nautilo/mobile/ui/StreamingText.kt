package app.nautilo.mobile.ui

import android.icu.text.BreakIterator
import androidx.compose.runtime.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.nautilo.mobile.data.StreamPacer

internal data class StreamText(val value: String, val live: Boolean, val fade: Boolean)

@Composable internal fun rememberStreamText(raw: String, streaming: Boolean, reveal: Boolean): StreamText {
    var streamed by remember { mutableStateOf(streaming) }
    if (!streaming && !streamed) return StreamText(raw, live = false, fade = false)
    val motion = LocalNautiloMotion.current
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    val animate = motion && lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    val pacer = remember {
        val iterator = BreakIterator.getCharacterInstance()
        StreamPacer { part ->
            iterator.setText(part)
            buildList {
                iterator.first()
                var boundary = iterator.next()
                while (boundary != BreakIterator.DONE) {
                    add(boundary)
                    boundary = iterator.next()
                }
            }
        }.apply { update(raw, streaming, animate = animate && streaming && reveal) }
    }
    var shown by remember { mutableStateOf(pacer.text) }
    LaunchedEffect(raw, streaming, animate) {
        if (streaming) streamed = true
        pacer.update(raw, streaming, animate && (streaming || streamed))
        shown = pacer.text
        while (pacer.pending) withFrameNanos { shown = pacer.frame(it) }
    }
    val value = if (animate && (streaming || streamed)) shown else raw
    val live = streaming || (animate && streamed && value != raw)
    return StreamText(value, live, animate && live)
}
