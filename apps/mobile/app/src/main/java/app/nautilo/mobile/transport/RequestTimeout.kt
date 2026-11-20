package app.nautilo.mobile.transport

import app.nautilo.mobile.data.RemoteFailure

/** A read timing out cannot imply that a chat message was not sent. */
internal fun requestTimeout(method: String): RemoteFailure = when (method) {
    "session.send", "session.followUp" -> RemoteFailure("REMOTE_RESPONSE_TIMEOUT", "电脑尚未确认发送结果，消息已保留，恢复连接后会核对。")
    "session.compact" -> RemoteFailure("COMMAND_OUTCOME_PENDING", "电脑仍在处理上下文压缩，请查看会话状态，不要重复提交。")
    "run.cancel", "session.create", "session.configure", "project.create", "approval.resolve", "interaction.respond", "attachment.upload" ->
        RemoteFailure("REMOTE_RESPONSE_TIMEOUT", "电脑尚未确认此操作的结果，请恢复连接后查看状态。")
    else -> RemoteFailure("REMOTE_SYNC_TIMEOUT", "同步电脑响应超时，正在恢复连接。")
}
