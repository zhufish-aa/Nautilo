const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("agenthub-fake-cli 1.0.0");
  process.exit(0);
}
if (args.includes("--hang")) {
  setInterval(() => {}, 1_000);
} else if (args.includes("--json") || args.includes("stream-json") || args.includes("json")) {
  console.log(JSON.stringify({ type: "message", text: "fixture ready" }));
  console.log(JSON.stringify({ type: "file.changed", path: "src/example.ts", change_type: "modified" }));
} else {
  console.log("fixture ready");
}
