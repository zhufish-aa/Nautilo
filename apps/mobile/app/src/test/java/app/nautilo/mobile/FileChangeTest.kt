package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.junit.Assert.*
import org.junit.Test

class FileChangeTest {
    @Test fun patchKeepsBothLineNumbersAndCountsBlankLinesAsChanges() {
        val patch = "--- a/file.ts\n+++ b/file.ts\n@@ -10,3 +10,4 @@\n same\n-old\n+new\n+\n end\n"
        val change = FileChange.decode(json("path" to "file.ts", "patch" to patch))
        assertEquals(2, change.added); assertEquals(1, change.removed)
        assertEquals(listOf(10, 11, 12, 13), change.lines.mapNotNull { it.newNumber })
        assertEquals(listOf(10, 11, 12), change.lines.mapNotNull { it.oldNumber })
    }
    @Test fun snapshotsProduceRealDiffRatherThanCountingEveryLineAsAdded() {
        val change = FileChange.decode(json("path" to "main.dart", "before" to "one\ntwo\nthree\n", "after" to "one\nTWO\nthree\n"))
        assertTrue(change.verifiedDiff); assertEquals(1, change.added); assertEquals(1, change.removed)
        val unchanged = FileChange.decode(json("path" to "main.dart", "before" to "same\r\n", "after" to "same\n"))
        assertEquals(0, unchanged.added); assertEquals(0, unchanged.removed)
    }
    @Test fun missingOriginalSnapshotIsNotPresentedAsAnAddedFile() {
        val unknown = FileChange.decode(json("path" to "script.ps1", "after" to "first\nsecond\n"))
        assertFalse(unknown.verifiedDiff); assertEquals(0, unknown.added)
        assertEquals(2, unknown.lines.size)
        val added = FileChange.decode(json("path" to "script.ps1", "changeType" to "added", "after" to "first\nsecond\n"))
        assertTrue(added.verifiedDiff); assertEquals(2, added.added)
    }
}
