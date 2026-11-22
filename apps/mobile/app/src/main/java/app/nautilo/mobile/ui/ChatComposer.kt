package app.nautilo.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.data.DraftAttachment
import kotlinx.coroutines.launch

internal val ChatBackground: Color @Composable get() = MobilePalette.canvas
internal val ComposerLine: Color @Composable get() = Line
internal val ComposerSecondary: Color @Composable get() = Secondary
private val ComposerSpring = CubicBezierEasing(.34f, 1.56f, .64f, 1f)

/** One field stays mounted while its surface expands on focus. */
@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun ChatComposer(
    text: String, onText: (String) -> Unit, placeholder: String,
    enabled: Boolean, canSend: Boolean, busy: Boolean = false,
    attachments: List<DraftAttachment> = emptyList(), attachmentBusy: Boolean = false,
    attachEnabled: Boolean = enabled, onAttach: () -> Unit,
    onRemoveAttachment: (DraftAttachment) -> Unit, onVoice: () -> Unit, onSend: () -> Unit,
    configurationEnabled: Boolean, onConfiguration: () -> Unit,
    onStop: (() -> Unit)? = null, focusedContent: (@Composable () -> Unit)? = null,
    inputFocusRequester: FocusRequester? = null,
    onModes: (() -> Unit)? = null,
    alwaysShowTools: Boolean = false,
    modesSelected: Boolean = false,
) {
    var focused by remember { mutableStateOf(false) }
    var attachmentMenu by remember { mutableStateOf(false) }
    val palette = MobilePalette
    val motion = LocalNautiloMotion.current
    val duration = if (motion) 180 else 0
    val toolsVisible = alwaysShowTools || focused && enabled
    val fieldInset by animateDpAsState(if (alwaysShowTools || focused) 16.dp else 54.dp,
        tween(duration, easing = MotionEase), label = "composer-text-inset")
    val fieldHeight by animateDpAsState(if (alwaysShowTools || focused) 64.dp else 56.dp,
        tween(duration, easing = MotionEase), label = "composer-field-height")
    val scope = rememberCoroutineScope()
    val pulse = remember { Animatable(1f) }
    val plusAngle = animateFloatAsState(if (attachmentMenu) 45f else 0f,
        tween(if (motion) 150 else 0, easing = MotionEase), label = "attachment-menu")
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val internalRequester = remember { FocusRequester() }
    val requester = inputFocusRequester ?: internalRequester
    val imeVisible = WindowInsets.isImeVisible
    // Focus owns the editing state. Keyboard insets can arrive late during a
    // dialog transition; using those callbacks to clear focus races the next tap.
    BackHandler(focused && !imeVisible) { focus.clearFocus() }
    val send = {
        if (canSend && !busy && !attachmentBusy) {
            if (motion) scope.launch {
                pulse.snapTo(0f)
                pulse.animateTo(1f, tween(320, easing = MotionEase))
            }
            onSend(); focus.clearFocus(); keyboard?.hide()
        }
    }
    val attach: @Composable () -> Unit = {
        Box {
            NIconButton(onClick = { if (alwaysShowTools) attachmentMenu = !attachmentMenu else onAttach() }, enabled = attachEnabled && !attachmentBusy && !busy,
                modifier = Modifier.size(44.dp).testTag("composer-attach")) {
                if (attachmentBusy) NSpinner(Modifier.size(19.dp), strokeWidth = 1.6.dp, color = Ink)
                else Icon(Icons.Outlined.Add, if (attachmentMenu) "关闭附件菜单" else "添加附件",
                    Modifier.size(22.dp).graphicsLayer { rotationZ = plusAngle.value }, tint = if (attachEnabled) Ink else ComposerSecondary.copy(alpha = .4f))
            }
            NMenu(expanded = attachmentMenu, onDismissRequest = { attachmentMenu = false }) {
                NMenuItem(text = { Text("选择文件") }, leadingIcon = { Icon(Icons.Outlined.AttachFile, null) },
                    onClick = { attachmentMenu = false; onAttach() })
            }
        }
    }
    val hasContent = text.isNotBlank() || attachments.isNotEmpty()
    val sendReady = animateFloatAsState(if (hasContent) 1f else 0f,
        tween(if (motion) 220 else 0, easing = ComposerSpring), label = "composer-send-ready")
    val primary: @Composable () -> Unit = {
        Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
            when {
                busy -> {
                    NSpinner(Modifier.size(38.dp), strokeWidth = 1.5.dp, color = Accent)
                    Icon(Icons.Outlined.Stop, "正在创建会话", Modifier.size(17.dp), tint = Accent)
                }
                hasContent -> NFilledIconButton(onClick = send, enabled = canSend && !attachmentBusy,
                    modifier = Modifier.size(40.dp).testTag("composer-send"), shape = CircleShape,
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = palette.primary, contentColor = palette.onPrimary,
                        disabledContainerColor = palette.inset, disabledContentColor = palette.muted)) {
                    Icon(Icons.Outlined.ArrowUpward, "发送消息", Modifier.size(22.dp).graphicsLayer {
                        val progress = sendReady.value
                        scaleX = .72f + .28f * progress
                        scaleY = scaleX
                        rotationZ = -32f * (1f - progress)
                    })
                }
                onStop != null -> NFilledIconButton(onClick = onStop, enabled = enabled, modifier = Modifier.size(40.dp),
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = palette.tint, contentColor = Accent)) {
                    NSpinner(Modifier.size(37.dp), strokeWidth = 1.5.dp, color = Accent)
                    MotionSymbol("stop") { Icon(Icons.Outlined.Stop, "停止生成", Modifier.size(20.dp)) }
                }
                else -> ComposerVoice(enabled, onVoice)
            }
            if (motion) Icon(Icons.Outlined.ArrowUpward, null, Modifier.size(20.dp).graphicsLayer {
                val takeoff = (pulse.value * 2.5f).coerceIn(0f, 1f)
                alpha = 1f - takeoff
                translationY = -13.dp.toPx() * takeoff
            }, tint = if (hasContent) palette.onPrimary else Accent)
        }
    }
    NPanel(color = palette.card, shape = RoundedCornerShape(22.dp),
        border = BorderStroke(1.dp, if (focused) Accent.copy(alpha = .48f) else palette.edge),
        shadowElevation = if (alwaysShowTools) 3.dp else 0.dp,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = 6.dp, bottom = 10.dp)
            .testTag("chat-composer")
            .clickable(enabled = enabled && !busy, indication = null, interactionSource = remember { MutableInteractionSource() }) {
                requester.requestFocus(); keyboard?.show()
            }) {
      Box {
        Column {
            if (attachments.isNotEmpty()) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 14.dp, end = 14.dp, top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                attachments.forEach { file -> if (app.nautilo.mobile.data.ChatAttachment.draft(file).isImage) {
                    Box {
                        AttachmentImage(app.nautilo.mobile.data.ChatAttachment.draft(file), compact = true)
                        NIconButton(onClick = { onRemoveAttachment(file) }, enabled = !busy,
                            modifier = Modifier.align(Alignment.TopEnd).padding(3.dp).size(30.dp)) {
                            Icon(Icons.Outlined.Cancel, "移除 ${file.name}", Modifier.size(23.dp), tint = Ink)
                        }
                    }
                } else NPanel(color = Selection, shape = RoundedCornerShape(14.dp)) {
                    Row(Modifier.padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (file.mimeType.startsWith("image/")) Icons.Outlined.Image else Icons.Outlined.InsertDriveFile, null, Modifier.size(18.dp), tint = ComposerSecondary)
                        Text(file.name, Modifier.widthIn(max = 150.dp).padding(start = 7.dp), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        NIconButton(onClick = { onRemoveAttachment(file) }, enabled = !busy, modifier = Modifier.size(40.dp)) {
                            Icon(Icons.Outlined.Close, "移除 ${file.name}", Modifier.size(15.dp), tint = ComposerSecondary)
                        }
                    }
                } }
            }
            // Keep the input at the same composition location while its layout expands.
            // Reparenting a focused field can drop focus on some Android keyboards.
            Box(Modifier.fillMaxWidth().heightIn(min = fieldHeight), contentAlignment = Alignment.CenterStart) {
                BasicTextField(value = text, onValueChange = onText, enabled = enabled && !busy,
                    modifier = Modifier.fillMaxWidth().heightIn(max = 160.dp)
                        .padding(start = fieldInset, end = fieldInset,
                            top = 15.dp, bottom = 15.dp)
                        .focusRequester(requester).onFocusChanged { focused = it.isFocused }.testTag("composer-input"),
                    maxLines = if (focused) 6 else 3,
                    textStyle = TextStyle(fontFamily = UiFont, color = Ink, fontSize = 17.sp, lineHeight = 26.sp),
                    cursorBrush = SolidColor(Accent), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                    keyboardActions = KeyboardActions(onSend = { send() }),
                    decorationBox = { input -> Box {
                        if (text.isEmpty()) Text(placeholder, color = palette.muted, fontSize = 17.sp, lineHeight = 26.sp)
                        input()
                    } })
            }
            AnimatedVisibility(toolsVisible,
                enter = expandVertically(tween(duration, easing = MotionEase), expandFrom = Alignment.Bottom) + fadeIn(tween(if (motion) 130 else 0)),
                exit = shrinkVertically(tween(if (motion) 150 else 0, easing = MotionEase), shrinkTowards = Alignment.Bottom) + fadeOut(tween(if (motion) 90 else 0))) {
              Column {
                focusedContent?.let { Box(Modifier.padding(horizontal = 14.dp)) { it() } }
                Spacer(Modifier.height(50.dp))
              }
            }
        }
        if (motion) Box(Modifier.align(Alignment.TopCenter).fillMaxWidth(.38f).height(2.dp).graphicsLayer {
            val progress = pulse.value
            alpha = kotlin.math.sin(progress * kotlin.math.PI).toFloat().coerceAtLeast(0f)
            translationX = size.width * (progress - .5f) * 2.6f
        }.background(Brush.horizontalGradient(listOf(Color.Transparent, Accent, Color.Transparent))))
        // These controls stay at the same composition location and bottom
        // edge throughout expansion. They never disappear for an empty frame.
        Row(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(start = 6.dp, end = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            attach()
            Spacer(Modifier.weight(1f))
            AnimatedVisibility(toolsVisible,
                enter = expandHorizontally(tween(duration, easing = MotionEase), expandFrom = Alignment.End) + fadeIn(tween(if (motion) 130 else 0, delayMillis = if (motion) 30 else 0)),
                exit = shrinkHorizontally(tween(if (motion) 150 else 0, easing = MotionEase), shrinkTowards = Alignment.End) + fadeOut(tween(if (motion) 90 else 0))) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    onModes?.let { open -> NIconButton(onClick = { focus.clearFocus(); keyboard?.hide(); open() }, enabled = toolsVisible && configurationEnabled && !busy,
                        modifier = Modifier.size(44.dp).testTag("composer-modes")) {
                        Box {
                            Icon(Icons.Outlined.Shield, "权限与 Harness 模式", Modifier.size(21.dp), tint = if (modesSelected) Accent else Ink)
                            if (modesSelected) Box(Modifier.align(Alignment.TopEnd).size(5.dp).background(Accent, CircleShape))
                        }
                    } }
                    NIconButton(onClick = { focus.clearFocus(); keyboard?.hide(); onConfiguration() }, enabled = toolsVisible && configurationEnabled && !busy,
                        modifier = Modifier.size(44.dp).testTag("composer-configuration")) {
                        MotionSymbol("configuration") { Icon(Icons.Outlined.Tune, "模型、推理强度与连接设置", Modifier.size(22.dp), tint = Ink) }
                    }
                    if (!alwaysShowTools && (hasContent || onStop != null) && !busy) ComposerVoice(focused && enabled, onVoice)
                }
            }
            primary()
        }
      }
    }
}

@Composable private fun ComposerVoice(enabled: Boolean, onVoice: () -> Unit) {
    NIconButton(onClick = onVoice, enabled = enabled, modifier = Modifier.size(44.dp).testTag("composer-voice")) {
        MotionSymbol("voice") { Icon(Icons.Outlined.MicNone, "语音输入", Modifier.size(23.dp), tint = if (enabled) Ink else ComposerSecondary.copy(alpha = .4f)) }
    }
}
