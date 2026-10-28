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

// Workout generation via OpenCode Go (https://opencode.ai/v2/docs/console/go/)
const GO_URL = "https://opencode.ai/inference/go/openai/v1/chat/completions";
const GO_MODEL = "glm-5.3-flash";

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

// Create Workout: send the classified prompt, the user's profile and the
// exercise catalog to GLM-5.3-Flash (OpenCode Go) and have it replace
// data/workout.json with the generated plan.
function readJsonFile(relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, relPath), "utf8"));
  } catch {
    return null;
  }
}

const WORKOUT_FILE = path.join(__dirname, "data", "workout.json");

function buildWorkoutPrompt() {
  return `You are SpotMe, an AI workout coach. Generate a workout plan from the request below.

Respond with ONLY a JSON object (no markdown fences, no commentary) matching exactly this schema:

{
  "name": "short workout name",
  "exercises": [
    {
      "id": "catalog exercise id, copied verbatim",
      "name": "catalog exercise name, copied verbatim",
      "custom": false,
      "exerciseType": "catalog exerciseType, copied verbatim",
      "sets": [
        { "weight": -1, "reps": -1, "complete": false, "rir": "RIR 1" }
      ]
    }
  ]
}

Rules:
- Only pick exercises from the exercise catalog. Copy id, name and exerciseType exactly as written there.
- Output ONLY the keys above. Never include instructions, videos, url, difficulty, muscleGroup, secondaryMuscleGroups or any other keys.
- Each set stays a placeholder: weight -1, reps -1, complete false.
- Choose set counts (2-5) and rir strings ("RIR 0", "RIR 1", "RIR 2") that fit the request, the user's goals and experience level.
- Respect the equipment the user has access to and any preferred muscle groups.`;
}

function parseModelJson(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : content).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return JSON.parse(raw.slice(start, end + 1));
}

function sanitizeGeneratedWorkout(parsed, catalog) {
  const byId = new Map(catalog.map((ex) => [ex.id, ex]));
  const byName = new Map(catalog.map((ex) => [ex.name.toLowerCase(), ex]));

  const exercises = (Array.isArray(parsed.exercises) ? parsed.exercises : [])
    .map((ex) => {
      const match = byId.get(ex?.id) || byName.get(String(ex?.name || "").toLowerCase());
      if (!match) return null;
      const sets = (Array.isArray(ex.sets) ? ex.sets : [])
        .slice(0, 10)
        .map((s) => ({
          weight: -1,
          reps: -1,
          complete: false,
          rir: /RIR/i.test(String(s?.rir || "")) ? s.rir : "RIR 1",
        }));
      return {
        id: match.id,
        name: match.name,
        custom: false,
        exerciseType: match.exerciseType,
        sets,
      };
    })
    .filter(Boolean);

  if (!exercises.length) {
    throw new Error("The model did not return any exercises from the catalog");
  }

  return {
    id: `workout-${Date.now()}`,
    name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Generated Workout",
    date: new Date().toISOString().slice(0, 10),
    exercises,
  };
}

async function callGo(messages, maxTokens = 4000, sessionTag = "spotme-create-workout") {
  const response = await fetch(GO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENCODE_GO_API_KEY}`,
      "User-Agent": "ait-670-spotme/0.1",
      "x-opencode-session": sessionTag,
    },
    body: JSON.stringify({
      model: GO_MODEL,
      messages,
      max_tokens: maxTokens,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `GLM request failed (${response.status})`);
  }
  return data.choices?.[0]?.message?.content || "";
}

async function handleCreateWorkout(req, res) {
  const { text, sessionId } = await readBody(req);
  if (!text || !text.trim()) {
    return sendJson(res, 400, { error: "text is required" });
  }
  const user = readJsonFile("data/user.json");
  const catalog = (readJsonFile("data/exercises.json") || []).map((ex) => ({
    id: ex.id,
    name: ex.name,
    exerciseType: ex.exerciseType,
    muscleGroup: ex.muscleGroup,
  }));
  if (!catalog.length) {
    return sendJson(res, 500, { error: "Exercise catalog is unavailable" });
  }

  try {
    const content = await callGo([
      { role: "system", content: buildWorkoutPrompt() },
      {
        role: "user",
        content: `User profile:\n${JSON.stringify(user, null, 2)}\n\nExercise catalog (JSON):\n${JSON.stringify(catalog)}\n\nRequest:\n${text.trim()}`,
      },
    ]);
    const workout = sanitizeGeneratedWorkout(parseModelJson(content), catalog);
    fs.writeFileSync(WORKOUT_FILE, JSON.stringify(workout, null, 2) + "\n");
    console.log(`Replaced data/workout.json with generated workout (${workout.exercises.length} exercises)`);
    sendJson(res, 200, {
      workout,
      savedTo: "data/workout.json",
      sessionId: typeof sessionId === "string" ? sessionId : undefined,
    });
  } catch (err) {
    console.error("Workout generation failed:", err.message);
    sendJson(res, 502, { error: err.message });
  }
}

// Give Workout Advice: send the whole session context (all prior user and
// assistant messages, plus the new prompt) to GLM-5.3-Flash (OpenCode Go) and
// return concise workout advice.
const ADVICE_SYSTEM_PROMPT = `You are SpotMe, an AI workout coach. Give concise workout advice in reply to the user's latest message.

Rules:
- Keep the answer short: 2-4 sentences, or at most a compact bullet list.
- Be practical and specific; no long essays, no disclaimers.
- Tailor the advice to the conversation history and the user's profile when relevant.`;

async function handleGiveWorkoutAdvice(req, res) {
  const { text, sessionId } = await readBody(req);
  if (!text || !text.trim()) {
    return sendJson(res, 400, { error: "text is required" });
  }

  const session = typeof sessionId === "string" ? readSession(sessionId) : null;
  const history = (session?.messages || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.trim() }));
  // The client also persists the newest user message; avoid sending it twice.
  const last = history[history.length - 1];
  if (last && last.role === "user" && last.content === text.trim()) history.pop();

  const user = readJsonFile("data/user.json");
  const systemContent = `${ADVICE_SYSTEM_PROMPT}\n\nUser profile:\n${JSON.stringify(user, null, 2)}`;

  try {
    const reply = await callGo(
      [
        { role: "system", content: systemContent },
        ...history,
        { role: "user", content: text.trim() },
      ],
      1000,
      sessionId ? `spotme-advice-${sessionId}` : "spotme-advice"
    );
    sendJson(res, 200, { reply, sessionId });
  } catch (err) {
    console.error("Workout advice failed:", err.message);
    sendJson(res, 502, { error: err.message });
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

async function handleRenameSession(req, res, sessionId) {
  const session = readSession(sessionId);
  if (!session) {
    return sendJson(res, 404, { error: "Session not found" });
  }
  const { title } = await readBody(req);
  if (typeof title !== "string" || !title.trim()) {
    return sendJson(res, 400, { error: "title is required" });
  }
  session.title = title.trim().slice(0, 60);
  session.updatedAt = new Date().toISOString();
  writeSession(session);
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
    if (req.method === "POST" && pathname === "/api/create-workout") return await handleCreateWorkout(req, res);
    if (req.method === "POST" && pathname === "/api/give-workout-advice") return await handleGiveWorkoutAdvice(req, res);
    if (req.method === "GET" && pathname === "/api/sessions") return sendJson(res, 200, { sessions: listSessions() });
    if (req.method === "POST" && pathname === "/api/sessions") return await handleCreateSession(req, res);
    if (req.method === "DELETE" && !pathname.endsWith("/messages") && pathname.startsWith("/api/sessions/")) {
      return handleDeleteSession(res, pathname.split("/")[3]);
    }
    if (req.method === "PATCH" && !pathname.endsWith("/messages") && pathname.startsWith("/api/sessions/")) {
      return await handleRenameSession(req, res, pathname.split("/")[3]);
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
