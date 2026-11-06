//! Pi-family extension UI, translated without cancelling supported dialogs.
use crate::{process::ProcessHandle, DaemonChannel};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;

pub fn dialog(value: &Value) -> Option<Value> {
    let method = value["method"].as_str()?;
    let title = value["title"].as_str().unwrap_or("扩展请求");
    if method == "confirm" {
        return Some(
            json!({"kind":"approval","title":title,"detail":value["message"],
            "options":[{"id":"confirm","label":"确认","intent":"approve"},{"id":"cancel","label":"取消","intent":"reject"}]}),
        );
    }
    if !["select", "input", "editor"].contains(&method) {
        return None;
    }
    let mut question = json!({"id":"value","question":title,"isOther":false});
    if method == "select" {
        question["options"] = json!(value["options"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(index, option)| {
                let label = option
                    .as_str()
                    .or_else(|| option["label"].as_str())
                    .unwrap_or("");
                json!({"id":index.to_string(),"label":label,"description":option["description"]})
            })
            .collect::<Vec<_>>());
    } else {
        question["inputType"] = json!(if method == "editor" {
            "multiline"
        } else {
            "text"
        });
        question["initialValue"] = json!(value["prefill"]
            .as_str()
            .or(value["initialValue"].as_str())
            .unwrap_or(""));
        question["placeholder"] = value["placeholder"].clone();
        question["allowEmpty"] = json!(true);
        question["preserveWhitespace"] = json!(true);
    }
    Some(json!({"kind":"question","title":title,"questions":[question]}))
}

pub fn answer(value: &Value, response: &Value) -> Value {
    let mut result = json!({"type":"extension_ui_response","id":value["id"]});
    if value["method"] == "confirm" {
        result["confirmed"] =
            json!(response["outcome"] == "selected" && response["optionId"] == "confirm");
    } else if response["outcome"] == "selected" {
        if let Some(text) = response["answers"]["value"][0].as_str() {
            // A select result must be one of the native choices, not an invented value.
            let valid = value["method"] != "select"
                || value["options"].as_array().is_some_and(|options| {
                    options.iter().any(|option| {
                        option.as_str().or_else(|| option["label"].as_str()) == Some(text)
                    })
                });
            if valid {
                result["value"] = json!(text);
            } else {
                result["cancelled"] = json!(true);
            }
        } else {
            result["cancelled"] = json!(true);
        }
    } else {
        result["cancelled"] = json!(true);
    }
    result
}

pub fn dispatch(
    value: &Value,
    handle: &ProcessHandle,
    sender: &mpsc::UnboundedSender<Value>,
    channel: &Option<Arc<dyn DaemonChannel>>,
    run_id: &str,
) {
    if let Some(mut input) = dialog(value) {
        input["nativeRequestId"] = value["id"].clone();
        if let Some(timeout) = value["timeout"].as_u64() {
            input["timeoutMs"] = json!(timeout);
        }
        let handle = handle.clone();
        let value = value.clone();
        let channel = channel.clone();
        let run_id = run_id.to_string();
        tokio::spawn(async move {
            let response = if let Some(channel) = channel {
                // Keep ONE pending request. Recreating ask on each heartbeat loses
                // the original answer and leaves duplicate cards in the UI.
                let pending = channel.ask(&run_id, input);
                tokio::pin!(pending);
                loop {
                    tokio::select! {
                        response = &mut pending => break response,
                        _ = handle.wait() => return,
                        _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => {
                            handle.write("{\"id\":\"nautilo-ui-heartbeat\",\"type\":\"get_state\"}\n");
                        }
                    }
                }
            } else {
                json!({"outcome":"cancelled"})
            };
            handle.write(&format!("{}\n", answer(&value, &response)));
        });
        return;
    }
    let method = value["method"].as_str().unwrap_or("");
    if [
        "notify",
        "setStatus",
        "setWidget",
        "setTitle",
        "set_editor_text",
        "setEditorText",
        "open_url",
        "cancel",
    ]
    .contains(&method)
    {
        let text = value["message"]
            .as_str()
            .or(value["statusText"].as_str())
            .or(value["text"].as_str())
            .or(value["title"].as_str())
            .map(str::to_string)
            .or_else(|| {
                value["widgetLines"].as_array().map(|lines| {
                    lines
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
            })
            .unwrap_or_default();
        let key = value
            .get("statusKey")
            .or_else(|| value.get("widgetKey"))
            .or_else(|| value.get("key"));
        let _ = sender
            .send(json!({"kind":"extension_ui","method":method,"key":key,"text":text,"raw":value}));
        return;
    }
    // Preserve unknown UI requests as a visible, attributable compatibility error.
    let _ = sender.send(json!({"kind":"error","message":format!("原生扩展请求 {method} 尚未映射到界面，请使用原生交互入口。"),"raw":value}));
    handle.write(&format!(
        "{}\n",
        json!({"type":"extension_ui_response","id":value["id"],"cancelled":true})
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_and_editor_round_trip_exact_values() {
        let select = json!({"id":"s","method":"select","title":"Pick","options":["one","two"]});
        assert_eq!(
            dialog(&select).unwrap()["questions"][0]["options"][1]["label"],
            "two"
        );
        assert_eq!(
            answer(
                &select,
                &json!({"outcome":"selected","answers":{"value":["two"]}})
            )["value"],
            "two"
        );
        assert_eq!(
            answer(
                &select,
                &json!({"outcome":"selected","answers":{"value":["invented"]}})
            )["cancelled"],
            true
        );
        let editor = json!({"id":"e","method":"editor","prefill":"\n original\n"});
        assert_eq!(
            dialog(&editor).unwrap()["questions"][0]["initialValue"],
            "\n original\n"
        );
        for text in ["", "\n changed\n"] {
            assert_eq!(
                answer(
                    &editor,
                    &json!({"outcome":"selected","answers":{"value":[text]}})
                )["value"],
                text
            );
        }
        assert_eq!(
            answer(&editor, &json!({"outcome":"cancelled"}))["cancelled"],
            true
        );
    }
}
