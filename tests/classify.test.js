const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const categories = {
  create_workout: "Create Workout",
  modify_workout: "Modify Workout",
  give_workout_advice: "Give Workout Advice",
  analyze_form: "Analyze Form",
};

function answer(choice = "create_workout", relevance = 0.99) {
  return {
    model: "jev-1.13.0",
    answers: {
      relevant: { type: "noul", noul: relevance },
      message_type: {
        type: "choice", choice, confidence: 0.7,
        probabilities: Object.fromEntries(Object.keys(categories).map((key) => [key, key === choice ? 0.85 : 0.05])),
      },
    },
    usage: { input_tokens: 300, output_tokens: 40 },
  };
}

// Run the real HTTP handler in a disposable checkout. Every external fetch is
// intercepted and Codex execution is blocked in the child, so these tests
// cannot read real keys or spend credits/subscription allowance.
async function fixture(t, replies, {
  dotenv = "TYPESAFE_API_KEY=typesafe-test-key\nOPENCODE_API_KEY=obsolete-key\n",
  environment = {},
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "spotme-classify-test-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.copyFile(path.join(__dirname, "..", "server.js"), path.join(directory, "server.js"));
  await fs.writeFile(path.join(directory, ".env"), dotenv);
  await fs.writeFile(path.join(directory, "replies.json"), JSON.stringify(replies));
  await fs.writeFile(path.join(directory, "calls.json"), "[]");
  await fs.writeFile(path.join(directory, "bootstrap.js"), `
    const fs = require("node:fs");
    const path = require("node:path");
    const http = require("node:http");
    require("node:child_process").execFile = () => {
      throw new Error("Classification tests must never invoke Codex");
    };
    const replies = require("./replies.json");
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, method: options.method, headers: options.headers,
        body: JSON.parse(options.body), hasSignal: options.signal instanceof AbortSignal });
      fs.writeFileSync(path.join(__dirname, "calls.json"), JSON.stringify(calls));
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected provider call");
      if (reply.throwName) {
        const error = new Error("private provider connection details");
        error.name = reply.throwName;
        throw error;
      }
      return new Response(reply.raw ?? JSON.stringify(reply.body), { status: reply.status || 200 });
    };
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      this.once("listening", () => process.send(this.address().port));
      return listen.apply(this, args);
    };
    require("./server.js");
  `);
  const childEnv = { ...process.env, PORT: "0", ...environment };
  for (const name of ["TYPESAFE_API_KEY", "TYPESAFE_MODEL"]) {
    if (!Object.hasOwn(environment, name)) delete childEnv[name];
  }
  child = fork(path.join(directory, "bootstrap.js"), [], { silent: true, env: childEnv });
  child.stdout.resume();
  child.stderr.resume();
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Test server did not start")), 5000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Test server exited before startup")); });
    child.once("message", (port) => { clearTimeout(timer); resolve(port); });
  });
  return {
    async post(body, route = "/api/classify") {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    },
    async calls() { return JSON.parse(await fs.readFile(path.join(directory, "calls.json"), "utf8")); },
  };
}

test("direct TypeSafe classification preserves all four Coach routes", async (t) => {
  for (const [type, label] of Object.entries(categories)) {
    await t.test(label, async (t) => {
      const app = await fixture(t, [{ body: answer(type) }]);
      const text = `A request to ${label}`;
      assert.deepEqual(await app.post({ text }), {
        status: 200,
        body: { ok: true, type, label, probability: 0.85, confidence: 0.7,
          probabilities: answer(type).answers.message_type.probabilities },
      });
      const calls = await app.calls();
      assert.equal(calls.length, 1, "one provider call per classification, without fallback");
      const [call] = calls;
      assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(call.method, "POST");
      assert.equal(call.headers.Authorization, "Bearer typesafe-test-key");
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.hasSignal, true, "provider calls have a timeout signal");
      assert.equal(call.body.model, "jev-1.13.0");
      assert.equal(call.body.state, text);
      assert.deepEqual(Object.keys(call.body.questions).sort(), ["message_type", "relevant"]);
      assert.equal(call.body.questions.relevant.type, "noul");
      assert.equal(call.body.questions.message_type.type, "choice");
      assert.deepEqual(Object.keys(call.body.questions.message_type.criteria).sort(), Object.keys(categories).sort());
    });
  }
});

test("relevance gate keeps its 0.5 boundary and ignores irrelevant choices", async (t) => {
  const irrelevant = answer("create_workout", 0.499);
  delete irrelevant.answers.message_type;
  const app = await fixture(t, [{ body: irrelevant }, { body: answer("modify_workout", 0.5) }]);
  assert.deepEqual(await app.post({ text: "What's the weather?" }), { status: 200, body: { relevant: false } });
  const relevant = await app.post({ text: "Modify my routine" });
  assert.equal(relevant.status, 200);
  assert.equal(relevant.body.label, "Modify Workout");
  assert.equal((await app.calls()).length, 2);
});

test("process environment overrides dotenv TypeSafe credentials and model", async (t) => {
  const app = await fixture(t, [{ body: answer() }], {
    dotenv: "TYPESAFE_API_KEY=dotenv-key\nTYPESAFE_MODEL=jev-1.13.0\n",
    environment: { TYPESAFE_API_KEY: "process-key", TYPESAFE_MODEL: "jev-1.14.0" },
  });
  assert.equal((await app.post({ text: "Create a workout" })).status, 200);
  const [call] = await app.calls();
  assert.equal(call.headers.Authorization, "Bearer process-key");
  assert.equal(call.body.model, "jev-1.14.0");
});

test("dotenv model override is honored", async (t) => {
  const app = await fixture(t, [{ body: answer() }], {
    dotenv: "TYPESAFE_API_KEY=test-key\nTYPESAFE_MODEL=jev-latest\n",
  });
  assert.equal((await app.post({ text: "Create a workout" })).status, 200);
  assert.equal((await app.calls())[0].body.model, "jev-latest");
});

test("missing TypeSafe key fails locally instead of reusing an OpenCode key", async (t) => {
  const app = await fixture(t, [], { dotenv: "OPENCODE_API_KEY=obsolete-key\nOPENCODE_GO_API_KEY=go-key\n" });
  assert.deepEqual(await app.post({ text: "Create a workout" }), {
    status: 503, body: { error: "Classification is not configured: set TYPESAFE_API_KEY." },
  });
  assert.deepEqual(await app.calls(), []);
});

test("invalid text is rejected before calling TypeSafe", async (t) => {
  const app = await fixture(t, []);
  for (const text of [undefined, "", "  ", 42, {}]) {
    assert.deepEqual(await app.post({ text }), { status: 400, body: { error: "text is required" } });
  }
  assert.deepEqual(await app.calls(), []);
});

test("provider errors fail without retries or exposing upstream details", async (t) => {
  for (const status of [401, 402, 422, 429, 500, 529]) {
    await t.test(String(status), async (t) => {
      const app = await fixture(t, [{ status, body: { error: { message: "PRIVATE_SENTINEL" } } }]);
      const response = await app.post({ text: "Create a workout" });
      assert.equal(response.status, 502);
      assert.match(response.body.error, /TypeSafe/);
      assert.doesNotMatch(response.body.error, /PRIVATE_SENTINEL/);
      if (status === 402) assert.match(response.body.error, /credits/);
      if (status === 401) assert.match(response.body.error, /TYPESAFE_API_KEY/);
      assert.equal((await app.calls()).length, 1);
    });
  }
  for (const throwName of ["TimeoutError", "AbortError", "TypeError"]) {
    await t.test(throwName, async (t) => {
      const app = await fixture(t, [{ throwName }]);
      const response = await app.post({ text: "Create a workout" });
      assert.equal(response.status, 502);
      assert.doesNotMatch(response.body.error, /private provider/);
      if (throwName !== "TypeError") assert.match(response.body.error, /timed out/);
      assert.equal((await app.calls()).length, 1);
    });
  }
});

test("malformed provider answers cannot become valid classifications", async (t) => {
  const cases = [
    { raw: "not json" }, { body: null }, { body: {} },
    { body: { answers: { relevant: { type: "noul", noul: "0.9" } } } },
    { body: { answers: { relevant: { type: "noul", noul: 2 } } } },
    { body: { answers: { relevant: { type: "choice", noul: 0.9 } } } },
  ];
  for (const change of [
    { choice: "unexpected" }, { choice: "toString" }, { choice: ["create_workout"] },
    { choice: { toString: "create_workout" } }, { type: "noul" },
    { confidence: null }, { probabilities: {} },
    { probabilities: { create_workout: -1, modify_workout: 0, give_workout_advice: 0, analyze_form: 0 } },
  ]) {
    const body = answer();
    Object.assign(body.answers.message_type, change);
    cases.push({ body });
  }
  for (const [index, reply] of cases.entries()) {
    await t.test(`malformed response ${index + 1}`, async (t) => {
      const app = await fixture(t, [reply]);
      const response = await app.post({ text: "Create a workout" });
      assert.equal(response.status, 502);
      assert.equal(response.body.label, undefined);
      assert.equal((await app.calls()).length, 1);
    });
  }
});
