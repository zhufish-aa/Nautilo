package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.junit.Assert.*
import org.junit.Test

class ReasoningPreviewTest {
    @Test fun cumulativeDeltasUpdateTheOriginalCollapsedActivityAndKeepTheFullText() {
        val projection = SessionProjection()
        val snapshots = listOf("先检查目录", "先检查目录\n\n正在读取文", "先检查目录\n\n正在读取文件", "先检查目录\n\n正在读取文件\r\n \t\r\n")
        val previews = listOf("先检查目录", "正在读取文", "正在读取文件", "正在读取文件")
        snapshots.forEachIndexed { index, text ->
            projection.apply(json("sequence" to index + 1, "eventId" to "chunk-$index", "runId" to "run", "type" to "agent.thinking_delta",
                "payload" to json("messageId" to "thought", "text" to text)))
            val item = projection.activityList().single()
            assertEquals(previews[index], reasoningPreview(item.detail))
            assertEquals(text, item.detail)
            assertTrue(item.running)
        }
        val id = projection.activityList().single().id
        projection.apply(json("sequence" to 5, "eventId" to "complete", "runId" to "run", "type" to "run.completed", "payload" to json()))
        val settled = projection.activityList().single()
        assertEquals(id, settled.id)
        assertFalse(settled.running)
        assertEquals("正在读取文件", reasoningPreview(settled.detail))
    }

    @Test fun longUnbrokenLinesRetainTheNewestTextRatherThanTheOpeningSentence() {
        val text = "开头不再显示。".repeat(150) + "最新思考正在更新"
        assertEquals(text.takeLast(500), reasoningPreview(text))
        assertTrue(reasoningPreview(text).endsWith("最新思考正在更新"))
    }

    @Test fun previewStripsMarkupAndHandlesEmptyContent() {
        assertEquals("正在读取 文件 src/main.ts", reasoningPreview("旧内容\n- **正在读取** [文件](https://example.com) `src/main.ts`"))
        assertEquals("", reasoningPreview(" \n\t"))
    }
}
