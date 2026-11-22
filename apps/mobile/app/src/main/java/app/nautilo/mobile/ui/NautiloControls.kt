@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package app.nautilo.mobile.ui

import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties

/** App-owned controls. Geometry, color, type and pressed states do not follow a device skin. */
@Composable fun NPanel(onClick: (() -> Unit)? = null, modifier: Modifier = Modifier, enabled: Boolean = true,
    shape: Shape = RoundedCornerShape(12.dp), color: Color = MobilePalette.card, contentColor: Color = Ink,
    shadowElevation: Dp = 0.dp, tonalElevation: Dp = 0.dp, border: BorderStroke? = null,
    interactionSource: MutableInteractionSource? = null, content: @Composable () -> Unit) {
    val ownInteraction = remember { MutableInteractionSource() }
    val interaction = interactionSource ?: ownInteraction
    val pressed by interaction.collectIsPressedAsState()
    val motion = LocalNautiloMotion.current
    val colors = MobilePalette
    val active = pressed && onClick != null && enabled
    val surfaceColor = if (!active) color else if (color == colors.primary) colors.pressed
        else if (color.alpha == 0f) colors.tint else lerp(color, colors.ink, .06f)
    val contentScale = animateFloatAsState(if (active && motion) if (shape == CircleShape) .94f else .985f else 1f,
        tween(if (motion) 120 else 0, easing = MotionEase), label = "surface-press")
    var surface = modifier
    if (onClick != null) surface = surface.clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
    CompositionLocalProvider(LocalContentColor provides contentColor) {
        Box(surface, propagateMinConstraints = true) {
            var layer = Modifier.graphicsLayer { scaleX = contentScale.value; scaleY = contentScale.value }
                .shadow(shadowElevation, shape).clip(shape).background(surfaceColor)
            if (border != null) layer = layer.border(border, shape)
            Box(layer, propagateMinConstraints = true) { content() }
        }
    }
}

@Composable fun NButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    shape: Shape = RoundedCornerShape(12.dp), colors: ButtonColors? = null, contentPadding: PaddingValues = PaddingValues(horizontal = 18.dp, vertical = 10.dp),
    content: @Composable RowScope.() -> Unit) {
    val background = if (enabled) colors?.containerColor ?: MobilePalette.primary else MobilePalette.inset
    val foreground = if (enabled) colors?.contentColor ?: MobilePalette.onPrimary else Secondary
    NPanel(onClick, modifier.widthIn(min = 64.dp).heightIn(min = 44.dp), enabled, shape, background, foreground) {
        CompositionLocalProvider(LocalTextStyle provides MaterialTheme.typography.labelLarge) {
            Row(Modifier.padding(contentPadding), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center, content = content)
        }
    }
}

@Composable fun NTextButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    contentPadding: PaddingValues = PaddingValues(horizontal = 12.dp, vertical = 10.dp), content: @Composable RowScope.() -> Unit) {
    NButton(onClick, modifier, enabled, RoundedCornerShape(10.dp),
        ButtonDefaults.buttonColors(containerColor = Color.Transparent, contentColor = Ink), contentPadding, content)
}
@Composable fun NOutlinedButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    shape: Shape = RoundedCornerShape(12.dp), content: @Composable RowScope.() -> Unit) {
    NButton(onClick, modifier.border(1.dp, Line, shape), enabled, shape,
        ButtonDefaults.buttonColors(containerColor = MobilePalette.card, contentColor = Ink), content = content)
}

@Composable fun NIconButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    interactionSource: MutableInteractionSource? = null, content: @Composable () -> Unit) {
    NPanel(onClick, modifier.size(44.dp), enabled, CircleShape,
        Color.Transparent, if (enabled) Ink else Secondary.copy(alpha = .4f), interactionSource = interactionSource) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
    }
}
@Composable fun NFilledIconButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    colors: IconButtonColors? = null, shape: Shape = CircleShape, interactionSource: MutableInteractionSource? = null, content: @Composable () -> Unit) {
    NPanel(onClick, modifier.size(40.dp), enabled, shape,
        if (enabled) colors?.containerColor ?: MobilePalette.primary else colors?.disabledContainerColor ?: MobilePalette.inset,
        if (enabled) colors?.contentColor ?: MobilePalette.onPrimary else colors?.disabledContentColor ?: Secondary, interactionSource = interactionSource) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
    }
}

@Composable fun NField(value: String, onValueChange: (String) -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true, label: (@Composable () -> Unit)? = null, placeholder: (@Composable () -> Unit)? = null,
    leadingIcon: (@Composable () -> Unit)? = null, trailingIcon: (@Composable () -> Unit)? = null,
    singleLine: Boolean = false, minLines: Int = 1, maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    shape: Shape = RoundedCornerShape(12.dp), visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default, keyboardActions: KeyboardActions = KeyboardActions.Default) {
    var focused by remember { mutableStateOf(false) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(7.dp)) {
        if (label != null) CompositionLocalProvider(LocalTextStyle provides MaterialTheme.typography.bodySmall, LocalContentColor provides Secondary) { label() }
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(shape).background(MobilePalette.inset)
            .border(1.dp, if (focused) Accent.copy(alpha = .48f) else Line, shape).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            leadingIcon?.let { Box(Modifier.padding(end = 10.dp)) { it() } }
            BasicTextField(value, onValueChange, enabled = enabled, singleLine = singleLine, minLines = minLines, maxLines = maxLines,
                visualTransformation = visualTransformation, keyboardOptions = keyboardOptions, keyboardActions = keyboardActions,
                textStyle = TextStyle(fontFamily = UiFont, fontSize = 16.sp, lineHeight = 25.sp, color = if (enabled) Ink else Secondary),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent), modifier = Modifier.weight(1f).padding(vertical = 11.dp).onFocusChanged { focused = it.isFocused },
                decorationBox = { field -> Box { if (value.isEmpty()) CompositionLocalProvider(LocalContentColor provides Secondary) { placeholder?.invoke() }; field() } })
            trailingIcon?.let { Box(Modifier.padding(start = 8.dp)) { it() } }
        }
    }
}

@Composable fun NChip(selected: Boolean, onClick: () -> Unit, label: @Composable () -> Unit, modifier: Modifier = Modifier,
    colors: SelectableChipColors? = null, enabled: Boolean = true) {
    NPanel(onClick, modifier, enabled, RoundedCornerShape(10.dp), if (selected) Selection else MobilePalette.card, border = BorderStroke(1.dp, if (selected) Accent.copy(alpha = .25f) else Line)) {
        Box(Modifier.padding(horizontal = 12.dp, vertical = 7.dp), contentAlignment = Alignment.Center) { label() }
    }
}

@Composable fun NDivider(modifier: Modifier = Modifier, thickness: Dp = 1.dp, color: Color = Line) { Box(modifier.fillMaxWidth().height(thickness).background(color)) }
@Composable fun NSpinner(modifier: Modifier = Modifier, strokeWidth: Dp = 1.8.dp, color: Color = Ink) {
    val angle = if (LocalNautiloMotion.current) rememberInfiniteTransition(label = "loading")
        .animateFloat(0f, 360f, infiniteRepeatable(tween(850, easing = LinearEasing)), label = "loading-rotation") else null
    Canvas(modifier.sizeIn(minWidth = 14.dp, minHeight = 14.dp).graphicsLayer { rotationZ = angle?.value ?: 0f }) {
        val stroke = strokeWidth.toPx()
        drawArc(color, 0f, 115f, false, topLeft = androidx.compose.ui.geometry.Offset(stroke, stroke),
            size = androidx.compose.ui.geometry.Size(size.width - stroke * 2, size.height - stroke * 2),
            style = Stroke(stroke, cap = StrokeCap.Round))
    }
}
@Composable fun NProgress(modifier: Modifier = Modifier) {
    val progress = if (LocalNautiloMotion.current) rememberInfiniteTransition(label = "progress")
        .animateFloat(-1f, 3.34f, infiniteRepeatable(tween(1100, easing = LinearEasing)), label = "progress-position") else null
    Box(modifier.fillMaxWidth().height(2.dp).clip(RectangleShape).background(Line)) {
        Box(Modifier.fillMaxWidth(.3f).fillMaxHeight().graphicsLayer { translationX = size.width * (progress?.value ?: 0f) }.background(Accent))
    }
}

@Composable fun NFloatingActionButton(onClick: () -> Unit, modifier: Modifier = Modifier, containerColor: Color = MobilePalette.card,
    contentColor: Color = Ink, content: @Composable () -> Unit) {
    NPanel(onClick, modifier.size(44.dp), shape = CircleShape, color = containerColor, contentColor = contentColor, shadowElevation = 3.dp, border = BorderStroke(.5.dp, Line)) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
    }
}

/** The sheet and its picker pages share one inset-aware Android window. */
@Composable fun NSheet(onDismissRequest: () -> Unit, containerColor: Color = MobilePalette.sheet, content: @Composable ColumnScope.() -> Unit) {
    val hostRoot = LocalView.current.rootView
    val palette = MobilePalette
    val motion = LocalNautiloMotion.current
    val dismiss by rememberUpdatedState(onDismissRequest)
    val blur = with(LocalDensity.current) { 6.dp.roundToPx() }
    // Compose 1.7's false branch ignores actual window measure specs and uses
    // screenHeightDp. Keep the normal measuring branch, with a full-size window.
    Dialog(onDismissRequest, properties = DialogProperties(usePlatformDefaultWidth = true, decorFitsSystemWindows = false)) {
        val entrance = remember { Animatable(if (motion) 0f else 1f) }
        LaunchedEffect(motion) {
            if (motion) entrance.animateTo(1f, tween(320, easing = MotionEase)) else entrance.snapTo(1f)
        }
        var drag by remember { mutableFloatStateOf(0f) }
        val settle = remember { Animatable(0f) }
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        val sizeWindow = remember(window) { Runnable {
            window?.apply {
                setLayout(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT)
                setGravity(android.view.Gravity.FILL)
                setSoftInputMode(if (android.os.Build.VERSION.SDK_INT >= 30) android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING else android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            }
        } }
        // Dialog.updateParameters runs after its children and restores WRAP_CONTENT.
        // Queue after that update on every recomposition, including picker changes.
        SideEffect { window?.decorView?.removeCallbacks(sizeWindow); window?.decorView?.post(sizeWindow) }
        DisposableEffect(window, hostRoot, blur) {
            // Set before the first draw, rather than in the posted size correction.
            window?.apply {
                setDimAmount(0f)
                attributes = attributes.apply {
                    windowAnimations = 0
                    if (android.os.Build.VERSION.SDK_INT >= 31 && windowManager.isCrossWindowBlurEnabled) {
                        blurBehindRadius = blur
                        flags = flags or android.view.WindowManager.LayoutParams.FLAG_BLUR_BEHIND
                    }
                }
            }
            sizeWindow.run()
            val decor = window?.decorView
            val observer = decor?.viewTreeObserver
            val firstFullFrame = android.view.ViewTreeObserver.OnPreDrawListener {
                val full = android.view.ViewGroup.LayoutParams.MATCH_PARENT
                val wrongParameters = window != null && (window.attributes.width != full || window.attributes.height != full)
                if (wrongParameters) sizeWindow.run()
                // updateParameters may restore the platform dialog width after
                // our effects. Never display that intermediate narrow frame.
                val narrow = decor != null && hostRoot.width > 0 && decor.width != hostRoot.width
                if (narrow) decor?.requestLayout()
                !wrongParameters && !narrow
            }
            observer?.addOnPreDrawListener(firstFullFrame)
            onDispose {
                decor?.removeCallbacks(sizeWindow)
                if (observer?.isAlive == true) observer.removeOnPreDrawListener(firstFullFrame)
            }
        }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
            Box(Modifier.matchParentSize().graphicsLayer {
                alpha = (entrance.value * 1.45f).coerceAtMost(1f) * (1f - drag / size.height.coerceAtLeast(1f)).coerceAtLeast(0f)
            }.background(palette.veil))
            val safePadding = WindowInsets.safeDrawing.asPaddingValues()
            BoxWithConstraints(Modifier.fillMaxSize().padding(safePadding).consumeWindowInsets(safePadding), contentAlignment = Alignment.BottomCenter) {
                val density = LocalDensity.current
                val threshold = with(density) { 88.dp.toPx() }
                val fling = with(density) { 850.dp.toPx() }
                val travel = with(density) { maxHeight.toPx() }
                val sheetHeight = maxHeight * .92f
                val shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp)
                val dismissTap = Modifier.clickable(indication = null, interactionSource = remember { MutableInteractionSource() }, onClick = dismiss)
                if (maxWidth > 640.dp) {
                    val gutter = (maxWidth - 640.dp) / 2
                    Spacer(Modifier.align(Alignment.CenterStart).width(gutter).fillMaxHeight().then(dismissTap))
                    Spacer(Modifier.align(Alignment.CenterEnd).width(gutter).fillMaxHeight().then(dismissTap))
                }
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Spacer(Modifier.fillMaxWidth().weight(1f).then(dismissTap))
                    Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().heightIn(max = sheetHeight).testTag("app-sheet")
                        .graphicsLayer {
                            // Raise the surface from the bottom edge while keeping the
                            // footer inside the safe area throughout the entrance.
                            transformOrigin = TransformOrigin(.5f, 1f)
                            scaleY = .94f + .06f * entrance.value
                            translationY = drag
                        }
                        .background(containerColor, shape).border(1.dp, palette.edge, shape)) {
                        Box(Modifier.fillMaxWidth().height(30.dp).testTag("sheet-grab-handle")
                            .draggable(rememberDraggableState { delta -> drag = (drag + delta).coerceAtLeast(0f) },
                                Orientation.Vertical, onDragStarted = { settle.stop() }, onDragStopped = { velocity ->
                                    val close = drag >= threshold || (drag > 0f && velocity > fling)
                                    if (motion) {
                                        settle.snapTo(drag)
                                        if (close) settle.animateTo(travel, tween(160, easing = MotionEase)) { drag = value }
                                        else settle.animateTo(0f, spring(dampingRatio = .8f, stiffness = 550f), velocity) { drag = value.coerceAtLeast(0f) }
                                    }
                                    if (close) dismiss()
                                    drag = 0f
                                }), contentAlignment = Alignment.Center) {
                            Box(Modifier.size(36.dp, 4.dp).background(palette.secondary.copy(alpha = .35f), CircleShape))
                        }
                        content()
                    }
                }
            }
        }
    }
}

@Composable fun NAlert(onDismissRequest: () -> Unit, title: @Composable () -> Unit, text: @Composable () -> Unit,
    confirmButton: @Composable () -> Unit, dismissButton: (@Composable () -> Unit)? = null) {
    Dialog(onDismissRequest, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        NAlertContent(title, text, confirmButton, dismissButton)
    }
}
@Composable internal fun NAlertContent(title: @Composable () -> Unit, text: @Composable () -> Unit,
    confirmButton: @Composable () -> Unit, dismissButton: (@Composable () -> Unit)? = null) {
    NPanel(modifier = Modifier.padding(horizontal = 24.dp).widthIn(max = 360.dp).fillMaxWidth(), shape = RoundedCornerShape(18.dp), border = BorderStroke(.5.dp, Line)) {
        Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            CompositionLocalProvider(LocalTextStyle provides MaterialTheme.typography.titleMedium.copy(fontSize = 19.sp, lineHeight = 27.sp), LocalContentColor provides Ink) { title() }
            CompositionLocalProvider(LocalTextStyle provides MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 25.sp), LocalContentColor provides Secondary) { text() }
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                dismissButton?.invoke(); confirmButton()
            }
        }
    }
}

@Composable fun NMenu(expanded: Boolean, onDismissRequest: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    if (expanded) Popup(popupPositionProvider = remember { object : PopupPositionProvider {
        override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset = IntOffset(
            (anchorBounds.right - popupContentSize.width).coerceIn(8, (windowSize.width - popupContentSize.width - 8).coerceAtLeast(8)),
            (if (anchorBounds.bottom + popupContentSize.height + 8 < windowSize.height) anchorBounds.bottom + 6 else anchorBounds.top - popupContentSize.height - 6).coerceAtLeast(8))
    } }, onDismissRequest = onDismissRequest, properties = PopupProperties(focusable = true)) {
        NPanel(modifier = Modifier.widthIn(min = 180.dp, max = 300.dp), shape = RoundedCornerShape(14.dp), shadowElevation = 6.dp, border = BorderStroke(.5.dp, Line)) {
            Column(Modifier.padding(5.dp), content = content)
        }
    }
}
@Composable fun NMenuItem(text: @Composable () -> Unit, onClick: () -> Unit, leadingIcon: (@Composable () -> Unit)? = null, enabled: Boolean = true) {
    NPanel(onClick, Modifier.fillMaxWidth(), enabled, RoundedCornerShape(9.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            leadingIcon?.invoke(); CompositionLocalProvider(LocalTextStyle provides MaterialTheme.typography.bodyMedium) { text() }
        }
    }
}
