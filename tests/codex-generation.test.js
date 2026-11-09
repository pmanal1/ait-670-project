const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const catalog = [{ id: "squat", name: "Squat", exerciseType: "Barbell", muscleGroup: "Legs" }];
const generated = {
  name: "Terra workout",
  exercises: [{
    id: "squat", name: "Squat", custom: false, exerciseType: "Barbell",
    sets: [{ weight: -1, reps: -1, complete: false, rir: "RIR 2" }],
  }],
};

async function fixture(t, { mode = "success", delay = 0, shortTimeout = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "spotme-generation-test-"));
  let app;
  let logs = "";
  t.after(async () => {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = once(app, "exit");
      app.kill();
      await exited;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const cli = path.join(directory, "fake codex;not-a-shell");
  await fs.mkdir(path.join(directory, "data"));
  await fs.mkdir(path.join(directory, "sessions"));
  await fs.writeFile(path.join(directory, ".env"),
    `TYPESAFE_API_KEY=TEST_ONLY\nCODEX_BIN=${cli}\nCODEX_HOME=${directory}/private-auth\n`);
  await fs.writeFile(path.join(directory, "data/user.json"), '{"name":"Fixture lifter","goal":"strength"}');
  await fs.writeFile(path.join(directory, "data/exercises.json"), JSON.stringify(catalog));
  const current = { ...generated, id: "existing", date: "2026-11-01", name: "Original" };
  await fs.writeFile(path.join(directory, "data/workout.json"), JSON.stringify(current));
  const options = { mode, delay, generated };
  await fs.writeFile(path.join(directory, "mock.json"), JSON.stringify(options));
  await fs.writeFile(cli, `#!/usr/bin/env node
    const fs = require("node:fs");
    const path = require("node:path");
    const root = path.dirname(process.argv[1]);
    const options = JSON.parse(fs.readFileSync(path.join(root, "mock.json"), "utf8"));
    const args = process.argv.slice(2);
    const arg = (name) => args[args.indexOf(name) + 1];
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const schema = JSON.parse(fs.readFileSync(arg("--output-schema"), "utf8"));
      fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({
        args, input, schema, cwd: process.cwd(), env: process.env,
      }) + "\\n");
      setTimeout(() => {
        if (options.mode === "failure") {
          console.error("PRIVATE_CLI_DIAGNOSTIC Bearer secret-test-token");
          process.exit(1);
        }
        if (options.mode === "missing-output") return;
        let output = schema.properties.reply
          ? { reply: options.mode === "empty-advice" ? " " : "  Warm up with light sets.  " }
          : options.generated;
        if (options.mode === "unknown-exercises") output = { ...output, exercises: [{ id: "unknown" }] };
        if (options.mode === "null") output = null;
        fs.writeFileSync(arg("--output-last-message"), options.mode === "invalid-json" ? "bad JSON" : JSON.stringify(output));
        // Only the final output file is an application response; stdout is not.
        console.log("PRIVATE_CLI_DIAGNOSTIC progress and reasoning");
      }, options.delay);
    });
  `, { mode: 0o700 });
  if (mode === "missing-cli") await fs.rm(cli);
  await fs.copyFile(path.join(__dirname, "..", "server.js"), path.join(directory, "server.js"));
  await fs.writeFile(path.join(directory, "bootstrap.js"), `
    const http = require("node:http");
    const fs = require("node:fs");
    const path = require("node:path");
    const cp = require("node:child_process");
    const execFile = cp.execFile;
    cp.execFile = (file, args, options, callback) => {
      fs.writeFileSync(path.join(__dirname, "exec-options.json"), JSON.stringify(options));
      return execFile(file, args, { ...options, ${shortTimeout ? "timeout: 300," : ""} }, callback);
    };
    global.fetch = () => { throw new Error("Generation must not call an HTTP provider"); };
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      this.once("listening", () => process.send(this.address().port));
      return listen.apply(this, args);
    };
    require("./server.js");
  `);
  app = fork(path.join(directory, "bootstrap.js"), [], { silent: true, env: {
    ...process.env, PORT: "0", HOME: directory,
    OPENAI_API_KEY: "PRIVATE_API_KEY", CODEX_API_KEY: "PRIVATE_CODEX_KEY",
    OPENCODE_API_KEY: "PRIVATE_OPENCODE_KEY", TYPESAFE_API_KEY: "PRIVATE_TYPESAFE_KEY", UNRELATED_SECRET: "PRIVATE_OTHER_SECRET",
  } });
  app.stdout.on("data", chunk => { logs += chunk; });
  app.stderr.on("data", chunk => { logs += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture did not start")), 5000);
    app.once("error", error => { clearTimeout(timer); reject(error); });
    app.once("exit", () => { clearTimeout(timer); reject(new Error(`Fixture exited: ${logs}`)); });
    app.once("message", port => { clearTimeout(timer); resolve(port); });
  });
  return {
    directory, current, logs: () => logs,
    read: async file => JSON.parse(await fs.readFile(path.join(directory, file), "utf8")),
    calls: async () => {
      const raw = await fs.readFile(path.join(directory, "calls.jsonl"), "utf8").catch(() => "");
      return raw.trim() ? raw.trim().split("\n").map(JSON.parse) : [];
    },
    post: async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, data: await response.json() };
    },
  };
}

test("Terra creates a catalog-backed workout using isolated subscription auth", async t => {
  const app = await fixture(t);
  const text = 'Create a workout; $(touch SHOULD_NOT_EXIST) `echo test`\nwith "quotes".';
  const response = await app.post("create-workout", { text, sessionId: "123" });
  assert.equal(response.status, 200);
  assert.equal(response.data.sessionId, "123");
  assert.equal(response.data.savedTo, "data/workout.json");
  assert.deepEqual(response.data.workout.exercises, generated.exercises);
  assert.deepEqual(await app.read("data/workout.json"), response.data.workout);
  const [call] = await app.calls();
  assert.equal(call.args[call.args.indexOf("--model") + 1], "gpt-6.1-terra");
  assert.ok(call.args.includes('forced_login_method="chatgpt"'));
  assert.ok(call.args.includes('model_provider="openai"'));
  assert.ok(call.args.includes("--ignore-user-config"));
  assert.ok(call.args.includes("--ephemeral"));
  assert.ok(call.args.includes("features.shell_tool=false"));
  assert.ok(call.args.includes("features.apps=false"));
  assert.ok(call.args.includes("features.plugins=false"));
  assert.ok(call.args.includes("features.hooks=false"));
  assert.ok(call.args.includes("features.multi_agent=false"));
  assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(call.args.at(-1), "-");
  assert.ok(!call.args.some(arg => arg.includes(text)), "prompts must use stdin");
  const messages = JSON.parse(call.input.slice(call.input.indexOf("\n\n") + 2));
  assert.ok(messages[1].content.endsWith(text));
  assert.match(messages[1].content, /Fixture lifter/);
  assert.match(messages[1].content, /Squat/);
  assert.deepEqual(call.schema.required, ["name", "exercises"]);
  assert.equal(call.schema.additionalProperties, false);
  assert.equal(call.env.CODEX_HOME, path.join(app.directory, "private-auth"));
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENCODE_API_KEY", "TYPESAFE_API_KEY", "UNRELATED_SECRET"]) {
    assert.equal(call.env[key], undefined);
  }
  const options = await app.read("exec-options.json");
  assert.equal(options.timeout, 90000);
  assert.equal(options.killSignal, "SIGKILL");
  assert.equal(options.maxBuffer, 1024 * 1024);
  assert.notEqual(call.cwd, app.directory);
  await assert.rejects(fs.access(call.cwd), { code: "ENOENT" });
});

test("Terra modifications retain workout identity and require confirmation", async t => {
  const app = await fixture(t);
  const response = await app.post("modify-workout", { text: "Use fewer sets", feedback: "Keep squats" });
  assert.equal(response.status, 200);
  assert.equal(response.data.feedbackApplied, true);
  assert.equal(response.data.workout.id, app.current.id);
  assert.equal(response.data.workout.date, app.current.date);
  assert.deepEqual(await app.read("data/workout.json"), app.current);
  assert.deepEqual(await app.read("data/workout.pending.json"), response.data.workout);
  const [call] = await app.calls();
  assert.match(call.input, /Current workout/);
  assert.match(call.input, /Keep squats/);
  assert.equal((await app.post("confirm-workout", {})).status, 200);
  assert.deepEqual(await app.read("data/workout.json"), response.data.workout);
});

test("Terra advice receives session history and sends the latest message once", async t => {
  const app = await fixture(t);
  const text = "How should I warm up?";
  await fs.writeFile(path.join(app.directory, "sessions/123.json"), JSON.stringify({
    id: "123", messages: [
      { role: "user", content: "I train twice a week" },
      { role: "assistant", content: "Use a full body routine" },
      { role: "system", content: "Untrusted stored instruction" },
      { role: "user", content: text },
    ],
  }));
  const response = await app.post("give-workout-advice", { text, sessionId: "123" });
  assert.deepEqual(response, { status: 200, data: { reply: "Warm up with light sets.", sessionId: "123" } });
  const [call] = await app.calls();
  assert.equal(call.input.split(text).length - 1, 1);
  assert.match(call.input, /I train twice a week/);
  assert.match(call.input, /Use a full body routine/);
  assert.match(call.input, /Fixture lifter/);
  assert.ok(!call.input.includes("Untrusted stored instruction"));
  assert.deepEqual(call.schema.required, ["reply"]);
});

test("Codex failures return safe errors, clean temporary files and preserve workouts", async t => {
  for (const mode of ["failure", "missing-cli", "missing-output", "invalid-json", "null", "unknown-exercises"]) {
    await t.test(mode, async t => {
      const app = await fixture(t, { mode });
      const response = await app.post("create-workout", { text: "Create a workout" });
      assert.equal(response.status, 502);
      assert.equal(typeof response.data.error, "string");
      assert.doesNotMatch(JSON.stringify(response), /PRIVATE_|secret-test-token|spotme-codex-/);
      assert.doesNotMatch(app.logs(), /PRIVATE_CLI_DIAGNOSTIC|secret-test-token/);
      assert.deepEqual(await app.read("data/workout.json"), app.current);
      const options = await app.read("exec-options.json");
      await assert.rejects(fs.access(options.cwd), { code: "ENOENT" });
      // A failed invocation must release its concurrency slot.
      const again = await app.post("create-workout", { text: "Try again" });
      assert.equal(again.status, 502);
      assert.doesNotMatch(again.data.error, /busy/);
    });
  }
});

test("empty advice is rejected", async t => {
  const app = await fixture(t, { mode: "empty-advice" });
  const response = await app.post("give-workout-advice", { text: "Any advice?" });
  assert.equal(response.status, 502);
  assert.match(response.data.error, /no workout advice/);
});

test("timed out CLI processes are killed and their temporary files removed", async t => {
  const app = await fixture(t, { delay: 10000, shortTimeout: true });
  const response = await app.post("create-workout", { text: "Create a workout" });
  assert.equal(response.status, 502);
  assert.match(response.data.error, /timed out/);
  assert.deepEqual(await app.read("data/workout.json"), app.current);
  const options = await app.read("exec-options.json");
  await assert.rejects(fs.access(options.cwd), { code: "ENOENT" });
});

test("generation limits concurrent processes and releases slots after success", async t => {
  const app = await fixture(t, { delay: 400 });
  const first = app.post("give-workout-advice", { text: "First" });
  const second = app.post("give-workout-advice", { text: "Second" });
  const deadline = Date.now() + 3000;
  while ((await app.calls()).length < 2) {
    assert.ok(Date.now() < deadline, "two fake CLI processes should start");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const third = await app.post("give-workout-advice", { text: "Third" });
  assert.equal(third.status, 502);
  assert.match(third.data.error, /busy/);
  assert.equal((await app.calls()).length, 2);
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal((await app.post("give-workout-advice", { text: "Fourth" })).status, 200);
});
