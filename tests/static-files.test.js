const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("static serving exposes only the UI's public files", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "spotme-static-test-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const publicFiles = {
    "index.html": "<!doctype html><title>SpotMe fixture</title>",
    "styles.css": "body { color: black; }",
    "script.js": "console.log('public fixture');",
    "data/user.json": '{"name":"Test profile"}',
    "data/workout.json": '{"exercises":[]}',
  };
  const privateFiles = {
    ".env": "OPENCODE_API_KEY=PRIVATE_TEST_SENTINEL",
    ".env.example": "OPENCODE_API_KEY=",
    ".git/config": "PRIVATE_TEST_SENTINEL",
    ".git/HEAD": "ref: refs/heads/main",
    ".git/objects/test": "PRIVATE_TEST_SENTINEL",
    "README.md": "Private project documentation",
    "sessions/123.json": '{"id":"123","title":"Test chat","messages":[]}',
    "data/workout.pending.json": '{"exercises":[]}',
    "data/exercises.json": "[]",
    "data/musclewiki-exercises.json": "[]",
    "unexpected.js": "PRIVATE_TEST_SENTINEL",
    "styles.css.map": "PRIVATE_TEST_SENTINEL",
  };
  for (const [name, content] of Object.entries({ ...publicFiles, ...privateFiles })) {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  await fs.copyFile(path.join(__dirname, "..", "server.js"), path.join(directory, "server.js"));
  // Use the app's real listen arguments to verify its network binding too.
  await fs.writeFile(path.join(directory, "bootstrap.js"), `
    const http = require("node:http");
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      this.once("listening", () => process.send(this.address()));
      return listen.apply(this, args);
    };
    require("./server.js");
  `);
  child = fork(path.join(directory, "bootstrap.js"), [], {
    silent: true,
    env: { ...process.env, PORT: "0" },
  });
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Test server did not start")), 5000);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Test server exited before startup")));
    child.once("message", (address) => {
      clearTimeout(timer);
      resolve(address);
    });
  });
  assert.equal(address.address, "127.0.0.1", "upstream must be loopback-only");
  const port = address.port;

  function get(route) {
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: "127.0.0.1", port, path: route }, (res) => {
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

  await t.test("public assets retain their content and MIME types", async () => {
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };
    for (const [name, content] of Object.entries(publicFiles)) {
      const response = await get(`/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.body, content, name);
      assert.equal(response.headers["content-type"], types[path.extname(name)], name);
    }
    for (const route of ["/", "/?v=1", "/index.html?v=1"]) {
      assert.equal((await get(route)).body, publicFiles["index.html"], route);
    }
  });

  await t.test("private files and path variants return 404", async () => {
    const routes = [
      ...Object.keys(privateFiles).map((name) => `/${name}`),
      "/server.js", "/bootstrap.js", "/missing.js", "/data/", "/sessions/",
      "/.env?download=1", "/data/../.env", "/%2eenv", "/%2egit/config",
      "/data/%2e%2e/.env", "/%2e%2e/.env", "/sessions%2f123.json",
    ];
    for (const route of routes) {
      const response = await get(route);
      assert.equal(response.status, 404, route);
      assert.equal(response.body, "Not found", route);
    }
  });

  await t.test("existing session API routing still works", async () => {
    const response = await get("/api/sessions");
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).sessions[0].id, "123");
  });
});
