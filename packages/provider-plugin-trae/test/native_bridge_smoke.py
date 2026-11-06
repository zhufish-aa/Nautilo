"""Offline native CLI regression: stream, attachment, effort, then resume.

Run with the Python from the installed Trae Agent environment.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

requests = []
read_target = ""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        text = "checking-fixture" if len(requests) == 1 else "remembered-fixture" if len(requests) == 2 else "continued-fixture"
        tool = "str_replace_based_edit_tool" if len(requests) == 1 else "task_done"
        tool_id = "view_fixture" if len(requests) == 1 else "done_fixture"
        arguments = {"command":"view","path":read_target} if len(requests) == 1 else {}
        events = [
            {"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":None,"stop_sequence":None,"usage":{"input_tokens":12,"output_tokens":0}}},
            {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}},
            {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"checking fixture"}},
            {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"fixture-signature"}},
            {"type":"content_block_stop","index":0},
            {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}},
            {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":text}},
            {"type":"content_block_stop","index":1},
            {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":tool_id,"name":tool,"input":{}}},
            {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":json.dumps(arguments)}},
            {"type":"content_block_stop","index":2},
            {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":None},"usage":{"output_tokens":7}},
            {"type":"message_stop"},
        ]
        for event in events:
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()


def main():
    global read_target
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="nautilo-trae-native-test-") as temporary:
            root = Path(temporary)
            bridge = root / "bridge"
            bridge.mkdir()
            shutil.copyfile(Path(__file__).parents[1] / "resources/sitecustomize.py", bridge / "sitecustomize.py")
            image = root / "fixture.png"
            (root / "fixture.txt").write_text("native tool fixture",encoding="utf-8")
            read_target = str(root / "fixture.txt")
            image.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII="))
            config = {"agents":{"trae_agent":{"model":"selected","max_steps":2,"enable_lakeview":False,"tools":["task_done","str_replace_based_edit_tool"]}},
                "models":{"selected":{"model":"fixture","model_provider":"fixture","max_tokens":2048,"temperature":0.5,"top_p":1,"top_k":0,"parallel_tool_calls":True,"max_retries":0}},
                "model_providers":{"fixture":{"provider":"anthropic","api_key":"test-fixture","base_url":f"http://127.0.0.1:{server.server_port}"}}}
            config_path = root / "config.yaml"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            for turn in range(2):
                env = {**os.environ, "PYTHONPATH":str(bridge), "PYTHONUTF8":"1", "NAUTILO_TRAE_BRIDGE":"1",
                    "NAUTILO_TRAE_SESSION_ID":"nautilo-trae:fixture", "NAUTILO_TRAE_STATE":str(root / "conversation.json"),
                    "NAUTILO_TRAE_RESUME":str(turn), "NAUTILO_TRAE_EFFORT":"max",
                    "NAUTILO_TRAE_IMAGES":json.dumps([str(image)] if turn == 0 else [])}
                result = subprocess.run([sys.executable, "-m", "trae_agent.cli", "run", "first fixture" if turn == 0 else "continue fixture",
                    "--config-file",str(config_path),"--trajectory-file",str(root / "trajectory.json"),"--working-dir",str(root)],
                    env=env, capture_output=True, text=True, encoding="utf-8", timeout=40,
                    creationflags=0x08000000 if os.name == "nt" else 0)
                assert result.returncode == 0, (result.stderr + result.stdout)[-4500:]
                frames = [json.loads(line[len("@nautilo-event:"):]) for line in result.stdout.splitlines() if line.startswith("@nautilo-event:")]
                assert any(frame["kind"] == "message" and frame.get("phase") == "delta" for frame in frames), result.stdout[-3000:]
                assert any(frame["kind"] == "thinking" and frame.get("phase") == "delta" for frame in frames)
                assert any(frame["kind"] == "usage" and frame.get("usageScope") == "turn" for frame in frames)
                if turn == 0:
                    tools = [frame for frame in frames if frame["kind"] == "tool" and frame.get("callId") == "view_fixture"]
                    assert [frame["phase"] for frame in tools] == ["started","completed"]
                    assert tools[-1]["success"] is True
            assert len(requests) == 3, len(requests)
            assert requests[0]["output_config"]["effort"] == "max"
            assert any(block.get("type") == "image" for message in requests[0]["messages"] if isinstance(message.get("content"),list) for block in message["content"])
            assert "remembered-fixture" in json.dumps(requests[2]["messages"])
            assert "native tool fixture" in json.dumps(requests[2]["messages"])
            assert "done_fixture" not in json.dumps(requests[2]["messages"]), "orphaned task_done replayed"
            print("Trae native stream / thinking / tools / image / effort / resume: passed")
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
