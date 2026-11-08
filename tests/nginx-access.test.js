const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const nginx = process.env.NGINX_BIN;
const authorization = `Basic ${Buffer.from("paulo:test-password-only").toString("base64")}`;
const aiRoutes = ["classify", "create-workout", "modify-workout", "give-workout-advice"];

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function request(port, route, { method = "GET", auth, origin, forwarded, secure = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (auth) headers.Authorization = auth;
    if (origin) headers.Origin = origin;
    if (forwarded) headers["X-Forwarded-For"] = forwarded;
    const req = (secure ? https : http).request({
      hostname: "127.0.0.1", port, path: route, method, headers,
      rejectUnauthorized: false, agent: false,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("Request timed out")));
    req.end();
  });
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "spotme-nginx-test-"));
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const httpPort = await freePort();
  const httpsPort = await freePort();
  // Disposable credentials and certificate; never read a deployed password file.
  const hash = execFileSync("openssl", ["passwd", "-6", "-stdin"], {
    input: "test-password-only\n", encoding: "utf8",
  }).trim();
  await fs.writeFile(path.join(directory, "htpasswd"), `paulo:${hash}\n`, { mode: 0o600 });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=spotme-test", "-keyout", path.join(directory, "key.pem"),
    "-out", path.join(directory, "cert.pem")], { stdio: "ignore" });

  // Exercise the production config, replacing only deployment-specific paths
  // and ports. Authentication, maps, limits, and proxy directives stay intact.
  let site = await fs.readFile(path.join(__dirname, "..", "deploy", "nginx", "spotme.conf"), "utf8");
  site = site
    .replace("listen 80;", `listen 127.0.0.1:${httpPort};`)
    .replace("listen [::]:80;", "")
    .replace("listen 443 ssl;", `listen 127.0.0.1:${httpsPort} ssl;`)
    .replace("listen [::]:443 ssl;", "")
    .replace("/etc/letsencrypt/live/ait670.paulomanalo.dev/fullchain.pem", `${directory}/cert.pem`)
    .replace("/etc/letsencrypt/live/ait670.paulomanalo.dev/privkey.pem", `${directory}/key.pem`)
    .replace("include /etc/letsencrypt/options-ssl-nginx.conf;", "ssl_protocols TLSv1.2 TLSv1.3;")
    .replace("ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;", "")
    .replace("/etc/nginx/spotme.htpasswd", `${directory}/htpasswd`)
    .replace("http://127.0.0.1:5173", `http://127.0.0.1:${upstream.address().port}`);
  const config = path.join(directory, "nginx.conf");
  await fs.writeFile(config, `
    daemon off;
    master_process off;
    pid ${directory}/nginx.pid;
    error_log ${directory}/error.log;
    events { worker_connections 128; }
    http {
      access_log off;
      client_body_temp_path ${directory}/body;
      proxy_temp_path ${directory}/proxy;
      ${site}
    }
  `);
  execFileSync(nginx, ["-t", "-p", `${directory}/`, "-c", config], { stdio: "pipe" });
  child = spawn(nginx, ["-p", `${directory}/`, "-c", config], { stdio: "pipe" });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.on("error", (error) => { errors += error.message; });
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await request(httpPort, "/", { secure: false });
      break;
    } catch (error) {
      if (child.exitCode !== null || Date.now() >= deadline) {
        throw new Error(`Nginx failed to start: ${errors || error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return { httpPort, httpsPort, received };
}

test("Nginx private access", { skip: !nginx && "Set NGINX_BIN to run Nginx integration tests" }, async (t) => {
  await t.test("HTTP redirects; anonymous and incorrect logins never reach the app", async (t) => {
    const { httpPort, httpsPort, received } = await fixture(t);
    const redirect = await request(httpPort, "/api/sessions?x=1", { secure: false });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, "https://ait670.paulomanalo.dev/api/sessions?x=1");
    assert.equal(redirect.headers["www-authenticate"], undefined);
    const routes = [
      ["GET", "/"], ["GET", "/script.js"], ["GET", "/data/user.json"],
      ["GET", "/data/workout.json"], ["GET", "/api/sessions"],
      ["POST", "/api/sessions"], ["PATCH", "/api/sessions/123"],
      ["DELETE", "/api/sessions/123"], ["POST", "/api/confirm-workout"],
      ["DELETE", "/api/confirm-workout"],
      ...aiRoutes.map((route) => ["POST", `/api/${route}`]),
    ];
    for (const [method, route] of routes) {
      const response = await request(httpsPort, route, { method });
      assert.equal(response.status, 401, `${method} ${route}`);
      assert.match(response.headers["www-authenticate"], /Basic realm="SpotMe private access"/);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    const wrong = `Basic ${Buffer.from("paulo:wrong").toString("base64")}`;
    assert.equal((await request(httpsPort, "/", { auth: wrong })).status, 401);
    assert.equal(received.length, 0);
  });

  await t.test("authenticated reads and writes work; credentials stay at Nginx", async (t) => {
    const { httpsPort, received } = await fixture(t);
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const response = await request(httpsPort, "/api/sessions/123", {
        method, auth: authorization, origin: "https://ait670.paulomanalo.dev",
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(JSON.parse(response.body), { ok: true });
    }
    for (const origin of ["https://other.example", "null", "https://ait670.paulomanalo.dev.evil.example"]) {
      assert.equal((await request(httpsPort, "/api/sessions", {
        method: "POST", auth: authorization, origin,
      })).status, 403);
    }
    assert.equal(received.length, 4);
    assert.ok(received.every((req) => req.authorization === undefined));
  });

  await t.test("AI endpoints share a rate limit across routes and query strings", async (t) => {
    const { httpsPort, received } = await fixture(t);
    for (const route of aiRoutes) {
      assert.equal((await request(httpsPort, `/api/${route}`, {
        method: "POST", auth: authorization,
      })).status, 200);
    }
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await request(httpsPort, `/api/%63lassify?attempt=${i}`, {
        method: "POST", auth: authorization,
      })).status);
    }
    assert.ok(statuses.includes(429), "changing route encoding/query must not bypass the budget");
    assert.ok(received.length <= 6, "excess paid requests must not reach the upstream");
    assert.equal((await request(httpsPort, "/", { auth: authorization })).status, 200);
  });

  await t.test("repeated password attempts are throttled despite spoofed forwarding headers", async (t) => {
    const { httpsPort, received } = await fixture(t);
    const statuses = await Promise.all(Array.from({ length: 35 }, (_, i) =>
      request(httpsPort, "/", { forwarded: `192.0.2.${i}` }).then((r) => r.status)));
    assert.ok(statuses.includes(401));
    assert.ok(statuses.includes(429));
    assert.equal(received.length, 0);
  });
});
