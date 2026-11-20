package app.nautilo.mobile

import app.nautilo.mobile.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import org.json.JSONObject

/** Screen-scoped, foreground-only reads; cancelling a read never cancels a desktop task. */
internal class MobileTeamController(
    private val scope: CoroutineScope,
    private val visible: StateFlow<Boolean>,
    private val state: StateFlow<MobileState>,
    private val update: ((MobileState) -> MobileState) -> Unit,
    private val request: suspend (Host, String, JSONObject) -> JSONObject,
    private val openConversation: (Conversation) -> Unit
) {
    private var job: Job? = null
    private val refresh = Channel<Unit>(Channel.CONFLATED)
    private var generation = 0

    fun show() {
        val current = state.value
        val session = current.session ?: return
        val host = current.host ?: return
        if ("session.team" !in current.capabilities) {
            update { it.copy(error = "请更新电脑端以查看团队任务") }; return
        }
        leave()
        val version = generation
        val root = session.parentSessionId.ifBlank { session.id }
        while (refresh.tryReceive().isSuccess) { /* Coalesce stale refresh taps. */ }
        update { it.copy(screen = Screen.TeamTasks, teamTasksLoading = true, teamTasksError = "", teamTasksCancelling = false,
            teamTasks = if (it.teamTasks.sessionId == root) it.teamTasks else TeamTaskSnapshot(sessionId = root)) }
        job = scope.launch {
            while (isActive && version == generation && state.value.host?.id == host.id && state.value.screen == Screen.TeamTasks) {
                visible.first { it }
                try {
                    val snapshot = TeamTaskSnapshot.decode(request(host, "session.team", json("sessionId" to root)))
                    if (version == generation && state.value.host?.id == host.id) update {
                        it.copy(teamTasks = snapshot, teamTasksLoading = false, teamTasksError = "")
                    }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    if (version == generation) update { it.copy(teamTasksError = readableError(error), teamTasksLoading = false) }
                }
                // A completed graph still refreshes slowly to pick up the next dispatch.
                withTimeoutOrNull(if (state.value.teamTasks.active) 1_500L else 5_000L) { refresh.receive() }
            }
        }
    }

    fun refresh() { refresh.trySend(Unit) }
    fun leave() { generation++; job?.cancel(); job = null }

    private val retrying = mutableSetOf<String>()
    fun retry(task: TeamTask) {
        val host = state.value.host ?: return
        val snapshot = state.value.teamTasks
        if ("session.team.retry" !in state.value.capabilities || task.status !in listOf("failed", "cancelled") || !retrying.add(task.id)) return
        val version = generation
        scope.launch {
            try {
                request(host, "session.team.retry", json("sessionId" to snapshot.sessionId, "taskId" to task.id))
                if (version == generation) refresh()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (version == generation && state.value.host?.id == host.id) update { it.copy(teamTasksError = readableError(error)) }
            } finally { retrying.remove(task.id) }
        }
    }

    fun cancel() {
        val host = state.value.host ?: return
        val snapshot = state.value.teamTasks
        if (!snapshot.active || state.value.teamTasksCancelling) return
        val version = generation
        scope.launch {
            update { it.copy(teamTasksCancelling = true, teamTasksError = "") }
            try {
                request(host, "session.team.cancel", json("sessionId" to snapshot.sessionId))
                if (version == generation && state.value.host?.id == host.id) refresh()
            }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (version == generation && state.value.host?.id == host.id) update { it.copy(teamTasksError = readableError(error)) } }
            finally { if (version == generation && state.value.host?.id == host.id) update { it.copy(teamTasksCancelling = false) } }
        }
    }

    fun openTask(task: TeamTask) {
        if (task.sessionId.isBlank()) return
        val host = state.value.host ?: return
        val generation = generation
        scope.launch {
            try {
                val details = request(host, "session.details", json("sessionId" to task.sessionId))
                if (this@MobileTeamController.generation != generation || state.value.host?.id != host.id) return@launch
                val session = details.getJSONObject("session")
                openConversation(Conversation.decode(session).copy(agentId = details.optJSONObject("agent")?.text("id").orEmpty(),
                    teamName = details.optJSONObject("team")?.text("name").orEmpty()))
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (this@MobileTeamController.generation == generation && state.value.host?.id == host.id) update { it.copy(teamTasksError = readableError(error)) } }
        }
    }
}
