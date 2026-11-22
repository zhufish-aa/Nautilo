import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { agyCandidates } from "./upstream/platform.mjs";
import { fetchUsage } from "./upstream/usage.mjs";

// The direct read uses agy's native login without opening a sign-in or issuing a prompt.
delete process.env.CLOUD_CODE_URL;
const executable = agyCandidates({ ...process.env, AGY_PATH: process.argv[2] }, homedir()).find(existsSync);
try {
  const result = await fetchUsage(executable, { direct: true });
  process.stdout.write(JSON.stringify(result.windows));
} catch {
  process.exitCode = 1;
}
