package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.junit.Assert.*
import org.junit.Test

class TeamTaskGraphTest {
    private fun task(id: String, vararg dependencies: String, status: String = "ready") =
        TeamTask(id, id, status, dependencies.toList())

    @Test fun diamondKeepsSiblingsParallelAndJoinsBeforeVerification() {
        val tasks = listOf(task("verify", "ui", "events"), task("events", "analysis"), task("analysis", status = "completed"), task("ui", "analysis"))
        val stages = teamTaskStages(tasks)
        assertEquals(listOf(listOf("analysis"), listOf("events", "ui"), listOf("verify")), stages.map { it.tasks.map { t -> t.id } })
        assertFalse(stages.first().parallel)
        assertTrue(stages[1].parallel)
        assertEquals("等待 2 个并行任务完成", teamTaskWaiting(tasks[0], tasks))
        assertEquals(1, TeamTaskSnapshot(tasks = tasks).completed)
    }

    @Test fun serialDependenciesRemainSerialEvenWhenEverythingIsRunning() {
        val tasks = listOf(task("c", "b", status = "running"), task("a", status = "running"), task("b", "a", status = "running"))
        assertEquals(listOf("a", "b", "c"), teamTaskStages(tasks).map { it.tasks.single().id })
        assertTrue(teamTaskStages(tasks).none { it.parallel })
        val final = task("final", "a", "c")
        assertEquals("等待 2 个前置任务完成", teamTaskWaiting(final, tasks + final))
    }

    @Test fun independentRootsAreParallelAndCompletionDoesNotReorderTheGraph() {
        val first = listOf(task("a"), task("b"), task("c", "b"))
        val updated = first.map { if (it.id == "b") it.copy(status = "completed") else it.copy(status = "running") }
        assertTrue(teamTaskStages(first).first().parallel)
        assertEquals(teamTaskStages(first).map { it.tasks.map(TeamTask::id) }, teamTaskStages(updated).map { it.tasks.map(TeamTask::id) })
    }

    @Test fun missingDependenciesAndCyclesAreVisibleWithoutInventedOrdering() {
        val graph = teamTaskStages(listOf(task("start"), task("a", "b"), task("b", "a"), task("missing", "not-loaded")))
        assertEquals("start", graph[0].tasks.single().id)
        assertTrue(graph[1].unresolved)
        assertFalse(graph[1].parallel)
        assertEquals(3, graph[1].tasks.size)
        assertEquals("等待依赖任务", teamTaskWaiting(graph[1].tasks.last(), graph.flatMap { it.tasks }))
    }

    @Test fun cancelledAndFailedAreNotSuccessfulCompletionsOrFabricatedDiffCounts() {
        val data = TeamTaskSnapshot.decode(json("sessionId" to "s", "tasks" to org.json.JSONArray(listOf(
            json("id" to "a", "status" to "completed"), json("id" to "b", "status" to "cancelled"), json("id" to "c", "status" to "failed")))))
        assertEquals(1, data.completed)
        assertNull(data.tasks[0].additions)
        assertNull(data.tasks[0].deletions)
        assertFalse(data.active)
    }

    @Test fun aRetriedChildRemainsActiveAfterTheMainTurnHasFinished() {
        val completedMain = TeamTaskSnapshot(runId = "run", status = "completed", tasks = listOf(task("a", status = "completed"), task("b", status = "running")))
        assertTrue(completedMain.active)
        assertEquals(1, completedMain.completed)
        assertFalse(completedMain.copy(tasks = completedMain.tasks.map { it.copy(status = "completed") }).active)
    }
}
