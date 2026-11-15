package app.nautilo.mobile

import app.nautilo.mobile.data.*
import app.nautilo.mobile.ui.previewText
import app.nautilo.mobile.ui.previewCodeRows
import org.junit.Assert.*
import org.junit.Test

class FileReferenceTest {
    @Test fun windowsPathsAndMarkdownUrlPathsResolveToTheSameFile() {
        assertEquals(FileReference("D:/Nautilo/中文 文件.rs", 42), fileReference("/D:/Nautilo/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.rs#L42"))
        assertEquals(FileReference("D:/Nautilo/a+b.kt", 12), fileReference("file:///D:/Nautilo/a+b.kt:12:3"))
        assertEquals(FileReference("D:/Nautilo/a.rs"), fileReference("?agenthub-local-path=%2FD%3A%2FNautilo%2Fa.rs"))
        assertEquals(FileReference("src/main.rs"), fileReference("src/main.rs"))
        assertEquals(FileReference("package.json"), fileReference("package.json"))
        assertEquals(FileReference("D:/Nautilo/a.rs", 12), fileReference("/D:/Nautilo/a.rs#L12-L20"))
        assertEquals(FileReference("//server/share/a.md"), fileReference("file://server/share/a.md"))
    }
    @Test fun externalUrlsAndOrdinaryProseAreNotRemoteFileRequests() {
        for (value in listOf("https://example.com/a.rs", "mailto:a@example.com", "javascript:alert(1)", "data:text/plain,hi", "普通内容", "#section")) assertNull(value, fileReference(value))
    }
    @Test fun rawWindowsMarkdownLinksKeepTheLabelAndUseAnAppOwnedDestination() {
        val normalized = normalizeMarkdownFileLinks("[代码](D:\\Nautilo\\中文 文件.rs)")
        assertTrue(normalized.startsWith("[代码](?agenthub-local-path="))
        assertEquals(FileReference("D:\\Nautilo\\中文 文件.rs"), fileReference(normalized.substringAfter('(').dropLast(1)))
        assertEquals("[网页](https://example.com)", normalizeMarkdownFileLinks("[网页](https://example.com)"))
    }
    @Test fun utf8ContinuationDoesNotReplaceOrDuplicateBoundaryCharacters() {
        val bytes = "中文".toByteArray(Charsets.UTF_8)
        assertEquals("中", previewText(bytes.copyOfRange(0, 4)))
        assertEquals("中文", previewText(bytes))
        assertNull(previewText(byteArrayOf(1, 0, 2)))
        assertEquals("", previewText(byteArrayOf()))
    }
    @Test fun longJsonLinesStayCompleteWithoutCreatingAnUnboundedTextLayout() {
        val source = "x".repeat(20_000)
        val rows = previewCodeRows(source)
        assertEquals(source, rows.joinToString("") { it.text })
        assertTrue(rows.all { it.text.length <= 2_048 && it.line == 1 })
        assertTrue(rows.drop(1).all { it.continuation })
        assertEquals(listOf(1, 2), previewCodeRows("one\ntwo").map { it.line })
        val emoji = previewCodeRows("x".repeat(2047) + "😀" + "tail")
        assertFalse(emoji.first().text.last().isHighSurrogate())
        assertEquals("x".repeat(2047) + "😀tail", emoji.joinToString("") { it.text })
    }
}
