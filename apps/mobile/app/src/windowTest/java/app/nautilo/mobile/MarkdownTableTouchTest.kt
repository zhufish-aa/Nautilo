package app.nautilo.mobile

import android.app.Activity
import android.app.Application
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.TextView
import app.nautilo.mobile.ui.MarkdownView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35], qualifiers = "w393dp-h851dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MarkdownTableTouchTest {
    private fun descendants(view: View): List<View> = listOf(view) + if (view is ViewGroup)
        (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()

    private fun withTable(action: (MarkdownView, HorizontalScrollView) -> Unit) {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = controller.get()
        activity.setTheme(R.style.NautiloTheme)
        val root = FrameLayout(activity)
        val markdown = MarkdownView(activity)
        markdown.render("""
            | 第一列标题 | 第二列标题 | 第三列标题 | 第四列标题 |
            | --- | --- | --- | --- |
            | 第一行内容可以选择复制 | 第二列内容可以选择复制 | 第三列内容可以选择复制 | 第四列内容可以选择复制 |
            | 下一行第一列 | 下一行第二列 | 下一行第三列 | 下一行第四列 |
            | [配置文件](package.json) | 配置说明 | 路径说明 | 备注说明 |
        """.trimIndent())
        root.addView(markdown, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        activity.setContentView(root)
        val width = activity.resources.displayMetrics.widthPixels
        root.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1400, View.MeasureSpec.EXACTLY))
        root.layout(0, 0, width, 1400)
        shadowOf(Looper.getMainLooper()).idle()
        val table = descendants(markdown).filterIsInstance<HorizontalScrollView>().single()
        assertTrue("Fixture must have overflowing columns", table.getChildAt(0).width > table.width)
        table.scrollTo(0, 0)
        try { action(markdown, table) } finally { controller.pause().stop().destroy() }
    }

    private fun gesture(table: HorizontalScrollView, x: Float, y: Float, dx: Float = 0f, dy: Float = 0f) {
        val down = SystemClock.uptimeMillis()
        fun event(action: Int, elapsed: Long, atX: Float, atY: Float) {
            val event = MotionEvent.obtain(down, down + elapsed, action, atX, atY, 0)
            try { table.dispatchTouchEvent(event) } finally { event.recycle() }
        }
        event(MotionEvent.ACTION_DOWN, 0, x, y)
        if (dx != 0f || dy != 0f) event(MotionEvent.ACTION_MOVE, 40, x + dx, y + dy)
        event(MotionEvent.ACTION_UP, 120, x + dx, y + dy)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(300))
        table.computeScroll()
    }

    @Test fun tappingPartiallyVisibleColumnsDoesNotRepositionTheTable() = withTable { markdown, table ->
        val rowCell = descendants(markdown).filterIsInstance<TextView>().first { it.text.toString().startsWith("第二列内容") }
        val location = IntArray(2); rowCell.getLocationInWindow(location)
        val origin = IntArray(2); table.getLocationInWindow(origin)
        val y = (location[1] - origin[1] + rowCell.height / 2).toFloat()
        gesture(table, table.width - 20f, y)
        assertEquals("A stationary tap must not reveal or center a table cell", 0, table.scrollX)
    }

    @Test fun smallFingerMovementDuringTapDoesNotScroll() = withTable { markdown, table ->
        val cell = descendants(markdown).filterIsInstance<TextView>().first { it.text.toString().startsWith("第二列内容") }
        val position = IntArray(2); cell.getLocationInWindow(position)
        val origin = IntArray(2); table.getLocationInWindow(origin)
        val y = (position[1] - origin[1] + cell.height / 2).toFloat()
        val slop = ViewConfiguration.get(table.context).scaledTouchSlop.toFloat()
        gesture(table, table.width - 30f, y, dx = -slop / 2)
        assertEquals("Touch jitter below the drag threshold must not move the table", 0, table.scrollX)
    }

    @Test fun deliberateHorizontalDragStillScrolls() = withTable { _, table ->
        gesture(table, table.width * .8f, table.height * .6f, dx = -table.width * .5f)
        assertTrue("Wide tables must remain swipeable", table.scrollX > 0)
    }

    @Test fun tapsPreserveThePositionOfAnAlreadyScrolledTable() = withTable { _, table ->
        table.scrollTo(180, 0)
        val offset = table.scrollX
        gesture(table, 20f, table.height * .4f)
        assertEquals("Tapping a clipped left column must not jump back", offset, table.scrollX)
        gesture(table, table.width - 20f, table.height * .4f)
        assertEquals("Tapping a clipped right column must not jump forward", offset, table.scrollX)
    }

    @Test fun fileLinksInTableCellsRemainClickableWithoutMovingTheTable() = withTable { markdown, table ->
        val opened = mutableListOf<app.nautilo.mobile.data.FileReference>()
        markdown.onFileOpen = { opened += it }
        val cell = descendants(markdown).filterIsInstance<TextView>().first { it.text.toString() == "配置文件" }
        val position = IntArray(2); cell.getLocationInWindow(position)
        val origin = IntArray(2); table.getLocationInWindow(origin)
        val x = position[0] - origin[0] + cell.totalPaddingLeft + 10f
        val y = position[1] - origin[1] + cell.totalPaddingTop + (cell.layout.getLineTop(0) + cell.layout.getLineBottom(0)) / 2f
        gesture(table, x, y)
        assertEquals(listOf(app.nautilo.mobile.data.FileReference("package.json")), opened)
        assertEquals(0, table.scrollX)
    }

    @Test fun accessibilityScrollActionsStillMoveWideTables() = withTable { _, table ->
        assertTrue(table.performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null))
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(300)); table.computeScroll()
        assertTrue("Accessibility scrolling must remain available", table.scrollX > 0)
    }
}
