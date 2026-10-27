const http = require("http");
const fs = require("fs");
const path = require("path");

// Load .env (KEY=value per line)
const env = {};
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch {
  console.error("Warning: could not read .env");
}

const OPENCODE_API_KEY = env.OPENCODE_API_KEY;
const PORT = process.env.PORT || 5173;

// Chat sessions: one JSON file per session in /sessions, filename = id.
const SESSIONS_DIR = path.join(__dirname, "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function createSessionId() {
  let id = String(Date.now());
  while (fs.existsSync(path.join(SESSIONS_DIR, `${id}.json`))) {
    id = String(Number(id) + 1);
  }
  return id;
}

function readSession(id) {
  if (!/^\d+$/.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

function writeSession(session) {
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${session.id}.json`),
    JSON.stringify(session, null, 2),
  );
}

function listSessions() {
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readSession(f.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((session) => ({
      id: session.id,
      title: session.title || "Untitled",
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
    }));
}

const CLASSIFY_URL = "https://opencode.ai/zen/v1/systemone";
const CLASSIFY_MODEL = "jev-1.13";
const CLASSIFY_MODEL_FALLBACK = "jev-1.13-free";

// Preferred: a single "choice" question on the paid model. If that fails
// (e.g. out of funds), classification falls back to the free model with one
// yes/no question per type; the highest-probability type wins.
const CLASSIFICATION_TYPES = {
  create_workout: "Create Workout",
  modify_workout: "Modify Workout",
  give_workout_advice: "Give Workout Advice",
  analyze_form: "Analyze Form",
};

const QUESTION_INSTRUCTIONS = {
  create_workout:
    "The user asks the coach to create or generate a new workout plan or routine",
  modify_workout:
    "The user asks to change, edit or modify an existing workout plan or exercise",
  give_workout_advice:
    "The user asks for general workout training advice, tips or guidance",
  analyze_form:
    "The user asks the coach to analyze exercise form or technique, e.g. from a video",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// Preferred: one "choice" question on the paid model. The gateway currently
// answers 422 for choice/score questions ("Endpoint is unavailable"), so we
// fall back to the free model with one yes/no question per type and take the
// highest-probability type.
// Preliminary gate: ask Jev (as a yes/no probability) whether the message is
// relevant to any of the supported message types before classifying it.
const RELEVANCE_THRESHOLD = 0.5;

async function handleClassify(req, res) {
  const { text } = await readBody(req);
  if (!text || !text.trim()) {
    return sendJson(res, 400, { error: "text is required" });
  }

  const relevanceQuestions = {
    relevant: {
      type: "noul",
      instructions: `The message is a request the coach can act on, i.e. it matches at least one of these message types: ${Object.values(
        QUESTION_INSTRUCTIONS,
      ).join("; ")}`,
    },
  };

  let relevance = null;
  let lastError = "Relevance check failed";
  for (const model of [CLASSIFY_MODEL, CLASSIFY_MODEL_FALLBACK]) {
    const attemptResult = await callSystemOne(model, text, relevanceQuestions);
    if (attemptResult.ok) {
      relevance = attemptResult;
      break;
    }
    lastError = attemptResult.error || lastError;
  }
  if (!relevance) {
    return sendJson(res, 502, { error: lastError });
  }
  if (relevance.probability < RELEVANCE_THRESHOLD) {
    return sendJson(res, 200, { relevant: false });
  }

  const choiceQuestions = {
    message_type: {
      type: "choice",
      instructions: "Classify the sender message into exactly one type.",
      criteria: QUESTION_INSTRUCTIONS,
    },
  };
  const noulQuestions = Object.fromEntries(
    Object.keys(CLASSIFICATION_TYPES).map((key) => [
      key,
      { type: "noul", instructions: QUESTION_INSTRUCTIONS[key] },
    ]),
  );

  const attempts = [
    { model: CLASSIFY_MODEL, questions: choiceQuestions },
    { model: CLASSIFY_MODEL_FALLBACK, questions: noulQuestions },
  ];

  let result = null;
  lastError = "Classification failed";
  for (const attempt of attempts) {
    const attemptResult = await callSystemOne(attempt.model, text, attempt.questions);
    if (attemptResult.ok) {
      result = attemptResult;
      break;
    }
    lastError = attemptResult.error || lastError;
  }
  if (!result) {
    return sendJson(res, 502, { error: lastError });
  }
  sendJson(res, 200, {
    ...result,
    label: result.type ? CLASSIFICATION_TYPES[result.type] : "Unclassified",
  });
}

async function callSystemOne(model, state, questions, answerKeys) {
  const keys = answerKeys || Object.keys(questions);
  try {
    const upstream = await fetch(CLASSIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENCODE_API_KEY}`,
      },
      body: JSON.stringify({ model, state, questions }),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return { ok: false, error: data.error?.message || `Request failed (${upstream.status})` };
    }
    const choiceAnswer = data.answers?.message_type;
    if (choiceAnswer?.type === "choice" && CLASSIFICATION_TYPES[choiceAnswer.choice]) {
      return {
        ok: true,
        type: choiceAnswer.choice,
        probability: choiceAnswer.confidence ?? 1,
        probabilities: choiceAnswer.probabilities || undefined,
      };
    }
    const answers = data.answers || {};
    let bestKey = null;
    let bestScore = -1;
    const probabilities = {};
    for (const key of keys) {
      const score = answers[key]?.noul ?? 0;
      probabilities[key] = score;
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    if (!bestKey) {
      return { ok: false, error: "No answers returned" };
    }
    return { ok: true, type: bestKey, probability: bestScore, probabilities };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Chat session endpoints
async function handleCreateSession(req, res) {
  const { title } = await readBody(req);
  const now = new Date().toISOString();
  const session = {
    id: createSessionId(),
    title: typeof title === "string" && title.trim() ? title.trim().slice(0, 60) : "Untitled",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  writeSession(session);
  sendJson(res, 201, session);
}

async function handleAppendMessage(req, res, sessionId) {
  const session = readSession(sessionId);
  if (!session) {
    return sendJson(res, 404, { error: "Session not found" });
  }
  const { role, type, content } = await readBody(req);
  if (typeof content !== "string" || !content.trim()) {
    return sendJson(res, 400, { error: "content is required" });
  }
  if (role && !["user", "assistant"].includes(role)) {
    return sendJson(res, 400, { error: "Invalid role" });
  }
  const message = { content: content.trim(), createdAt: new Date().toISOString() };
  if (role) message.role = role;
  if (type) message.type = type;
  session.messages.push(message);
  session.updatedAt = message.createdAt;
  writeSession(session);
  sendJson(res, 200, message);
}

function handleDeleteSession(res, sessionId) {
  const session = readSession(sessionId);
  if (!session) {
    return sendJson(res, 404, { error: "Session not found" });
  }
  fs.unlinkSync(path.join(SESSIONS_DIR, `${sessionId}.json`));
  sendJson(res, 200, { ok: true });
}

function serveStatic(req, res, pathname) {
  const file = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(__dirname, path.normalize(file));
  if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  const sessionMatch = pathname.match(/^\/api\/sessions\/(\d+)\/messages$/) || pathname.match(/^\/api\/sessions\/(\d+)$/);
  try {
    if (req.method === "POST" && pathname === "/api/classify") return await handleClassify(req, res);
    if (req.method === "GET" && pathname === "/api/sessions") return sendJson(res, 200, { sessions: listSessions() });
    if (req.method === "POST" && pathname === "/api/sessions") return await handleCreateSession(req, res);
    if (req.method === "DELETE" && !pathname.endsWith("/messages") && pathname.startsWith("/api/sessions/")) {
      return handleDeleteSession(res, pathname.split("/")[3]);
    }
    if (req.method === "GET" && sessionMatch) {
      const session = readSession(sessionMatch[1]);
      return session ? sendJson(res, 200, session) : sendJson(res, 404, { error: "Session not found" });
    }
    if (req.method === "POST" && sessionMatch && pathname.endsWith("/messages")) return await handleAppendMessage(req, res, sessionMatch[1]);
    if (req.method === "GET") return serveStatic(req, res, pathname);
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`SpotMe running at http://localhost:${PORT}`);
});
