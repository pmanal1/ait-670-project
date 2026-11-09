const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("request URL parsing cannot crash the server", { timeout: 15000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "spotme-url-test-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const page = "<!doctype html><title>URL handling fixture</title>";
  await fs.writeFile(path.join(directory, "index.html"), page);
  await fs.writeFile(path.join(directory, ".env"), "TYPESAFE_API_KEY=TEST_ONLY\n");
  await fs.copyFile(path.join(__dirname, "..", "server.js"), path.join(directory, "server.js"));
  // Exercise the real HTTP listener in isolation, without using the app's data or keys.
  await fs.writeFile(path.join(directory, "bootstrap.js"), `
    const http = require("node:http");
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function () {
      this.once("listening", () => process.send(this.address().port));
      return listen.call(this, 0, "127.0.0.1");
    };
    require("./server.js");
  `);
  child = fork(path.join(directory, "bootstrap.js"), [], { silent: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.resume();
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Test server did not start")), 5000);
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Test server exited before startup: ${stderr}`));
    });
    child.once("message", (port) => { clearTimeout(timer); resolve(port); });
  });

  function get(route, host = `127.0.0.1:${port}`) {
    return new Promise((resolve, reject) => {
      // Node's HTTP client preserves these request targets and Host headers on the wire.
      const req = http.get({ hostname: "127.0.0.1", port, path: route, headers: { Host: host }, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("Request timed out")));
    });
  }

  await t.test("malformed request targets and Host headers return 400 and leave the process serving", async () => {
    const requests = [
      ["http://["],
      ["http://%"],
      ["/", "["],
      ["/api/sessions", "localhost:invalid"],
      ["/", "%"],
    ];
    for (const [route, host] of requests) {
      const label = `${route} (Host: ${host ?? "default"})`;
      const response = await get(route, host);
      assert.equal(response.status, 400, label);
      assert.equal(response.headers["content-type"], "application/json", label);
      assert.deepEqual(JSON.parse(response.body), { error: "Invalid request URL" }, label);
      assert.equal(child.exitCode, null, stderr);
      assert.equal(child.signalCode, null, stderr);
      const healthy = await get("/");
      assert.equal(healthy.status, 200, `Healthy request after ${label}`);
      assert.equal(healthy.body, page, label);
    }
  });

  await t.test("valid URLs, queries, and API routing still work", async () => {
    for (const [route, host] of [
      ["/"],
      ["/index.html?v=1"],
      ["http://localhost/index.html?v=1"],
      ["/", "localhost"],
      ["/", "[::1]:5173"],
    ]) {
      const response = await get(route, host);
      assert.equal(response.status, 200, route);
      assert.equal(response.body, page, route);
    }
    const response = await get("/api/sessions?v=1");
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { sessions: [] });
  });
});
