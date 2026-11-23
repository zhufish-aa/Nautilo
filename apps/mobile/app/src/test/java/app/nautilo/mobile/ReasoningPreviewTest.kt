package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.junit.Assert.*
import org.junit.Test

class ReasoningPreviewTest {
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
