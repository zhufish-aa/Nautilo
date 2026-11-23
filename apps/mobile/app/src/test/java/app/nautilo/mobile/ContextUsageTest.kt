package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ContextUsageTest {
    private fun event(seq: Long, payload: JSONObject, run: String = "run") = json(
        "eventId" to "e$seq", "sequence" to seq, "type" to "usage.updated", "runId" to run, "payload" to payload)

    @Test fun contextAndCapacityAreIndependentAndAccountingCannotEraseThem() {
        val p = ContextUsageProjection()
        p.ingest(event(1, json("contextWindow" to 200_000)))
        p.ingest(event(2, json("contextUsed" to 75_000, "usageScope" to "context")))
        p.ingest(event(3, json("usageScope" to "turn", "inputTokens" to 100, "outputTokens" to 20, "inputTokensIncludesCache" to true)))
        assertEquals(ContextUsage(75_000, 200_000, 120), p.value())
        assertEquals(37.5f, p.value().percentage!!, .001f)
        assertEquals(125_000L, p.value().available)
    }

    @Test fun usageSnapshotsReplaceRatherThanAddAndRetriedEventsCannotDoubleCount() {
        val p = ContextUsageProjection()
        fun total(seq: Long, input: Int, revision: Int = 1) = event(seq, json("usageScope" to "session", "usageKey" to "thread", "connectionId" to "account",
            "connectionRevision" to revision, "inputTokens" to input, "outputTokens" to 10, "inputTokensIncludesCache" to true))
        p.ingest(total(1, 100)); p.ingest(total(2, 200)); p.ingest(total(2, 200)); p.ingest(total(1, 100))
        assertEquals(210L, p.value().totalTokens)
        p.ingest(total(3, 50, revision = 2))
        assertEquals(270L, p.value().totalTokens)
    }

    @Test fun unknownCacheSemanticsDoNotBecomeAFalseTotalAndExclusiveCacheIsIncludedOnce() {
        val p = ContextUsageProjection()
        p.ingest(event(1, json("usageScope" to "turn", "inputTokens" to 100, "outputTokens" to 20)))
        assertNull(p.value().totalTokens)
        p.ingest(event(2, json("usageScope" to "turn", "inputTokens" to 100, "outputTokens" to 20, "inputTokensIncludesCache" to false,
            "cachedInputTokens" to 50, "cacheCreationInputTokens" to 10)))
        assertEquals(180L, p.value().totalTokens)
    }

    @Test fun reopeningHydratesUsageOutsideTheRecentActivityPageAndOlderPagesCannotRollItBack() {
        val p = SessionProjection()
        val usageEvents = JSONArray().put(event(1, json("contextWindow" to 1000)))
            .put(event(490, json("contextUsed" to 600)))
        p.history(json("items" to JSONArray(), "activity" to JSONArray(), "sequence" to 500, "epoch" to "epoch",
            "usage" to json("events" to usageEvents)), initialize = true)
        assertEquals(ContextUsage(600, 1000), p.contextUsage())
        p.apply(event(501, json("contextUsed" to 200)))
        p.history(json("items" to JSONArray(), "usage" to json("events" to JSONArray().put(event(2, json("contextUsed" to 900))))))
        assertEquals(ContextUsage(200, 1000), p.contextUsage())
    }

    @Test fun nativeCompactionMayDecreaseOccupancyAndMissingIsDifferentFromZero() {
        val p = ContextUsageProjection()
        assertNull(p.value().used); assertNull(p.value().percentage)
        p.ingest(event(1, json("contextWindow" to 1000, "contextUsed" to 900)))
        p.ingest(event(2, json("contextUsed" to 0)))
        assertEquals(0L, p.value().used)
        assertEquals(0f, p.value().percentage!!, 0f)
        assertEquals(1000L, p.value().available)
        assertNull(p.value().totalTokens)
    }

    @Test fun runtimeCapacityWinsOverModelFallbackAndInvalidObservationsAreIgnored() {
        val p = ContextUsageProjection()
        val model = json("contextWindow" to 1000)
        assertEquals(1000L, p.value().withModelWindow(model).window)
        p.ingest(event(1, json("contextWindow" to 2000, "contextUsed" to 2100)))
        p.ingest(event(2, json("contextWindow" to 0, "contextUsed" to -1)))
        assertEquals(2000L, p.value().withModelWindow(model).window)
        assertEquals(100f, p.value().percentage!!, 0f)
        assertEquals(0L, p.value().available)
        p.ingest(event(3, json("contextUsed" to "500", "contextWindow" to 1.5)))
        assertEquals(2100L, p.value().used)
        p.ingest(event(4, json("contextUsed" to 900, "subagentDispatchId" to "child")))
        assertEquals(2100L, p.value().used)
    }
}
