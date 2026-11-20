package app.nautilo.mobile.data

/** Content events are already projected locally. Only invalidate the resources they changed. */
internal data class SessionRefresh(val history: Boolean, val snapshot: Boolean) {
    companion object {
        fun forEvents(types: Iterable<String>): SessionRefresh {
            var history = false
            var snapshot = false
            for (type in types) {
                val terminal = type in setOf("run.completed", "run.cancelled", "run.failed")
                if (terminal || type == "session.native_history_synced" || type == "session.checkpoint_reverted") history = true
                if (terminal || type == "run.started" || type == "run.waiting" ||
                    type.startsWith("interaction.") || type.startsWith("approval.") ||
                    type.startsWith("session.follow_up") || type == "session.title_changed" ||
                    type == "session.checkpoint_reverted") snapshot = true
            }
            return SessionRefresh(history, snapshot)
        }
    }
}
