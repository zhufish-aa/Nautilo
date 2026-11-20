package app.nautilo.mobile.data

import org.json.JSONObject

data class MobileTeamMember(
    val id: String, val name: String, val harness: String = "", val providerId: String = "",
    val model: String = "", val status: String = "idle"
) {
    companion object {
        fun decode(value: JSONObject) = MobileTeamMember(value.text("id"), value.text("name"), value.text("harness"),
            value.text("providerId"), value.text("model"), value.text("status", "idle"))
    }
}

data class MobileTeam(val id: String, val name: String, val policy: String, val members: List<MobileTeamMember>) {
    companion object {
        fun decode(value: JSONObject) = MobileTeam(value.text("id"), value.text("name"), value.text("delegationPolicy"),
            value.objects("members").map(MobileTeamMember::decode))
    }
}

data class TeamTask(
    val id: String, val title: String, val status: String, val dependencies: List<String> = emptyList(),
    val memberId: String = "", val memberName: String = "", val harness: String = "", val sessionId: String = "",
    val createdAt: String = "", val activityName: String = "", val activityInput: String = "", val summary: String = "",
    val fileCount: Int = 0, val additions: Int? = null, val deletions: Int? = null
) {
    val completed get() = status == "completed"
    val executing get() = status in setOf("queued", "running", "verifying", "review_required", "merge_ready")
    val waiting get() = status in setOf("waiting_user", "waiting_approval")
    companion object {
        fun decode(value: JSONObject): TeamTask {
            val activity = value.optJSONObject("activity")
            return TeamTask(value.text("id"), value.text("title"), value.text("status"), value.strings("dependencies").distinct(),
                value.text("memberId"), value.text("memberName"), value.text("harness"), value.text("sessionId"),
                value.text("createdAt"), activity?.text("name").orEmpty(), activity?.text("text").orEmpty(),
                value.text("summary"), value.optInt("fileCount"),
                if (value.isNull("additions")) null else value.optInt("additions"),
                if (value.isNull("deletions")) null else value.optInt("deletions"))
        }
    }
}

data class TeamTaskStage(val tasks: List<TeamTask>, val unresolved: Boolean = false) {
    val parallel get() = tasks.size > 1 && !unresolved
}

/** Topological frontiers, never a status-sorted list pretending to be a dependency graph. */
fun teamTaskStages(tasks: List<TeamTask>): List<TeamTaskStage> {
    val pending = tasks.distinctBy { it.id }.sortedWith(compareBy<TeamTask> { it.createdAt }.thenBy { it.id }).toMutableList()
    val emitted = mutableSetOf<String>()
    val stages = mutableListOf<TeamTaskStage>()
    while (pending.isNotEmpty()) {
        val frontier = pending.filter { task -> task.dependencies.all { it in emitted } }
        if (frontier.isEmpty()) {
            // Missing dependencies and cycles stay visible, without inventing an execution order.
            stages += TeamTaskStage(pending.toList(), unresolved = true)
            break
        }
        stages += TeamTaskStage(frontier)
        emitted += frontier.map { it.id }
        pending.removeAll { it.id in emitted }
    }
    return stages
}

fun teamTaskWaiting(task: TeamTask, tasks: List<TeamTask>): String {
    val dependencies = task.dependencies.map { id -> tasks.find { it.id == id } }
    val blocked = dependencies.filter { it?.completed != true }
    return when {
        blocked.isEmpty() -> teamTaskStatus(task.status)
        blocked.any { it == null } -> "等待依赖任务"
        blocked.size > 1 -> {
            val ids = blocked.filterNotNull().map { it.id }.toSet()
            fun dependsOnSibling(node: TeamTask, visited: MutableSet<String>): Boolean = node.dependencies.any { id ->
                id in ids || (visited.add(id) && tasks.find { it.id == id }?.let { dependsOnSibling(it, visited) } == true)
            }
            val parallel = blocked.filterNotNull().none { dependsOnSibling(it, mutableSetOf(it.id)) }
            "等待 ${blocked.size} 个${if (parallel) "并行" else "前置"}任务完成"
        }
        else -> "等待「${blocked.first()!!.title}」完成"
    }
}

fun teamTaskStatus(status: String) = when (status) {
    "completed" -> "已完成"; "running" -> "运行中"; "queued" -> "排队中"; "verifying" -> "验证中"
    "waiting_user" -> "待回答"; "waiting_approval" -> "待批准"; "failed" -> "执行失败"
    "cancelled" -> "已停止"; "blocked_dependency" -> "等待依赖"; "review_required" -> "待审阅"
    "merge_ready" -> "待合并"; "ready", "draft", "pending" -> "待执行"; else -> "未开始"
}

data class WorkflowTodo(val id: String, val title: String, val kind: String, val detail: String) {
    companion object {
        fun decode(value: JSONObject) = WorkflowTodo(value.text("id"), value.text("title"), value.text("kind"), value.text("detail"))
    }
}

data class TeamTaskSnapshot(
    val sessionId: String = "", val project: String = "", val team: MobileTeam? = null,
    val runId: String = "", val goal: String = "", val status: String = "", val startedAt: String = "", val endedAt: String = "",
    val tasks: List<TeamTask> = emptyList(), val members: List<MobileTeamMember> = emptyList(),
    val workflowTodos: List<WorkflowTodo> = emptyList()
) {
    val completed get() = tasks.count { it.completed }
    val active get() = runId.isNotBlank() && (status !in setOf("completed", "failed", "cancelled") || tasks.any { it.executing || it.waiting })
    companion object {
        fun decode(value: JSONObject): TeamTaskSnapshot {
            val run = value.optJSONObject("run")
            return TeamTaskSnapshot(value.text("sessionId"), value.text("projectName"), value.optJSONObject("team")?.let(MobileTeam::decode),
                run?.text("id").orEmpty(), run?.text("goal").orEmpty(), run?.text("status").orEmpty(),
                run?.text("createdAt").orEmpty(), run?.text("endedAt").orEmpty(),
                value.objects("tasks").map(TeamTask::decode), value.objects("members").map(MobileTeamMember::decode),
                value.objects("workflowTodos").map(WorkflowTodo::decode))
        }
    }
}
