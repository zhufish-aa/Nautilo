import { createOptionalPtyRuntime } from "../../dist/index.js";

const runtime = createOptionalPtyRuntime();
if (!runtime.available) process.exit(77);
const command = process.platform === "win32" ? "cmd.exe" : process.execPath;
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", "echo fixture ready"]
  : ["-e", "console.log('fixture ready')"];
const handle = runtime.start({ command, args });
let output = "";
handle.onData((data) => { output += data; });
handle.onExit((exitCode) => process.exit(exitCode === 0 && /fixture ready/.test(output) ? 0 : 1));
setTimeout(() => { handle.kill(); process.exit(2); }, 5_000).unref();
