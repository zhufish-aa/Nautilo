import assert from "node:assert/strict";
import { app, session } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskBrowser } from "../../src/main/task-browser";

const profile = process.env.NAUTILO_COOKIE_PROFILE!;
for (const key of ["userData", "sessionData", "crashDumps"] as const)
  app.setPath(key, profile);
app.setAppLogsPath(profile);
void app
  .whenReady()
  .then(async () => {
    const browser = new TaskBrowser();
    await browser.start(() => "cookie-fixture");
    const jar = session.fromPartition("persist:nautilo-browser").cookies;
    const url = "https://cookie-fixture.example/";
    const phase = process.env.NAUTILO_COOKIE_PHASE;
    if (phase === "write")
      await jar.set({
        url,
        name: "fixture-login",
        value: "test-session-value",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        expirationDate: Date.now() / 1000 + 3600,
      });
    else if (phase === "verify" || phase === "logout") {
      const cookies = await jar.get({ url });
      const cookie = cookies.find((cookie) => cookie.name === "fixture-login");
      assert.equal(cookie?.value, "test-session-value");
      assert.equal(cookie?.httpOnly, true);
      if (phase === "logout") await jar.remove(url, "fixture-login");
    } else if (phase === "verify-logout")
      assert.equal(
        (await jar.get({ url })).some(
          (cookie) => cookie.name === "fixture-login",
        ),
        false,
      );
    else throw Error("Unknown cookie fixture phase");
    await browser.close();
    app.exit(0);
  })
  .catch((error) => {
    writeFileSync(
      join(profile, "cookie-error.txt"),
      error.stack ?? String(error),
    );
    app.exit(1);
  });

process.on("uncaughtException",error=>{require("node:fs").writeFileSync(require("node:path").join(__dirname,"cookie-error.txt"),error.stack??String(error));app.exit(1);});
