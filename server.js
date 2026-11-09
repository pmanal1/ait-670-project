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

const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY ?? env.TYPESAFE_API_KEY;
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

// Serialize read-modify-write mutations per session so concurrent message
// saves don't clobber each other (last write would otherwise win).
const sessionLocks = new Map();

function withSessionLock(id, fn) {
  const prev = (sessionLocks.get(id) || Promise.resolve()).catch(() => {});
  const next = prev.then(fn);
  sessionLocks.set(id, next.catch(() => {}));
  return next;
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

const CLASSIFY_URL = "https://api.typesafe.ai/v1/systemone";
const CLASSIFY_MODEL = process.env.TYPESAFE_MODEL || env.TYPESAFE_MODEL || "jev-1.13.0";
const CLASSIFY_TIMEOUT_MS = 15000;

// Workout generation via OpenCode Go (https://opencode.ai/v2/docs/console/go/)
const GO_URL = "https://opencode.ai/inference/go/openai/v1/chat/completions";
const GO_MODEL = "glm-5.3-flash";

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

// Ask the relevance Noul and category Choice together. The relevance gate
// still decides whether to use the category, even though both are returned.
const RELEVANCE_THRESHOLD = 0.5;

async function handleClassify(req, res) {
  const { text } = await readBody(req);
  if (typeof text !== "string" || !text.trim()) {
    return sendJson(res, 400, { error: "text is required" });
  }
  if (!TYPESAFE_API_KEY?.trim()) {
    return sendJson(res, 503, { error: "Classification is not configured: set TYPESAFE_API_KEY." });
  }

  const result = await callSystemOne(text, {
    relevant: {
      type: "noul",
      instructions: `The message is a request the coach can act on, i.e. it matches at least one of these message types: ${Object.values(
        QUESTION_INSTRUCTIONS,
      ).join("; ")}`,
    },
    message_type: {
      type: "choice",
      instructions: "Classify the sender message into exactly one type.",
      criteria: QUESTION_INSTRUCTIONS,
    },
  });
  if (!result.ok) {
    return sendJson(res, 502, { error: result.error });
  }

  const relevance = result.answers?.relevant;
  if (relevance?.type !== "noul" || !isProbability(relevance.noul)) {
    return sendJson(res, 502, { error: "TypeSafe returned an invalid relevance answer." });
  }
  if (relevance.noul < RELEVANCE_THRESHOLD) {
    return sendJson(res, 200, { relevant: false });
  }

  const answer = result.answers?.message_type;
  if (answer?.type !== "choice" || typeof answer.choice !== "string" ||
      !Object.hasOwn(CLASSIFICATION_TYPES, answer.choice) ||
      !isProbability(answer.confidence) ||
      !Object.keys(CLASSIFICATION_TYPES).every((key) => isProbability(answer.probabilities?.[key]))) {
    return sendJson(res, 502, { error: "TypeSafe returned an invalid classification answer." });
  }
  sendJson(res, 200, {
    ok: true,
    type: answer.choice,
    label: CLASSIFICATION_TYPES[answer.choice],
    probability: answer.probabilities[answer.choice],
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  });
}

function isProbability(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

async function callSystemOne(state, questions) {
  try {
    const upstream = await fetch(CLASSIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TYPESAFE_API_KEY}`,
      },
      body: JSON.stringify({ model: CLASSIFY_MODEL, state, questions }),
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      const errors = {
        401: "TypeSafe rejected the API key. Check TYPESAFE_API_KEY.",
        402: "TypeSafe credits are exhausted. Add credits in the TypeSafe console.",
        429: "TypeSafe rate limit reached. Try again shortly.",
        529: "TypeSafe is temporarily overloaded. Try again shortly.",
      };
      return { ok: false, error: errors[upstream.status] || `TypeSafe request failed (${upstream.status}).` };
    }
    const data = await upstream.json();
    return { ok: true, answers: data?.answers };
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { ok: false, error: "TypeSafe classification timed out. Try again shortly." };
    }
    // Keep upstream bodies and connection details out of the browser response.
    return { ok: false, error: "TypeSafe classification failed. Try again shortly." };
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
const PENDING_WORKOUT_FILE = path.join(__dirname, "data", "workout.pending.json");

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

function sanitizeGeneratedWorkout(parsed, catalog, baseWorkout) {
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
    id: baseWorkout?.id || `workout-${Date.now()}`,
    name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : baseWorkout?.name || "Generated Workout",
    date: baseWorkout?.date || new Date().toISOString().slice(0, 10),
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

// Modify Workout: send the classified prompt, the current workout, the user's
// profile and the exercise catalog to GLM-5.3-Flash (OpenCode Go). The model
// returns the full modified plan, which is written to data/workout.pending.json
// and shown to the user for confirmation. On confirm the pending file replaces
// data/workout.json; on reject the client re-runs this with the feedback.
function buildModifyWorkoutPrompt() {
  return `You are SpotMe, an AI workout coach. Modify the user's current workout plan according to the request and feedback below.

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
- Return the COMPLETE modified workout, including every exercise you keep unchanged. Do not omit exercises.
- Apply the requested changes: add, remove, swap or restructure exercises/sets as asked.
- For exercises you keep unchanged, preserve their set counts and rir strings exactly as in the current workout.
- Only pick exercises from the exercise catalog. Copy id, name and exerciseType exactly as written there.
- Output ONLY the keys above. Never include instructions, videos, url, difficulty, muscleGroup, secondaryMuscleGroups or any other keys.
- Each set stays a placeholder: weight -1, reps -1, complete false.
- If feedback from a previous rejection is provided, incorporate it fully into the new version.`;
}

async function handleModifyWorkout(req, res) {
  const { text, feedback } = await readBody(req);
  if (!text || !text.trim()) {
    return sendJson(res, 400, { error: "text is required" });
  }
  const currentWorkout = readJsonFile("data/workout.json");
  if (!currentWorkout || !Array.isArray(currentWorkout.exercises)) {
    return sendJson(res, 400, { error: "No current workout to modify" });
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

  const currentForModel = currentWorkout.exercises.map((ex) => ({
    id: ex.id,
    name: ex.name,
    exerciseType: ex.exerciseType,
    sets: (ex.sets || []).map((s) => ({ rir: s.rir })),
  }));
  const userContent = `User profile:\n${JSON.stringify(user, null, 2)}\n\nExercise catalog (JSON):\n${JSON.stringify(catalog)}\n\nCurrent workout (JSON):\n${JSON.stringify(currentForModel)}\n\nModification request:\n${text.trim()}`;
  const feedbackText = typeof feedback === "string" ? feedback.trim() : "";
  const fullContent = feedbackText
    ? `${userContent}\n\nThe user rejected the previous proposed version with this feedback:\n${feedbackText}\n\nProduce a new version that addresses the feedback.`
    : userContent;

  try {
    const content = await callGo(
      [
        { role: "system", content: buildModifyWorkoutPrompt() },
        { role: "user", content: fullContent },
      ],
      4000,
      "spotme-modify-workout"
    );
    const workout = sanitizeGeneratedWorkout(
      parseModelJson(content),
      catalog,
      currentWorkout
    );
    fs.writeFileSync(PENDING_WORKOUT_FILE, JSON.stringify(workout, null, 2) + "\n");
    console.log(`Wrote proposed workout to data/workout.pending.json (${workout.exercises.length} exercises)`);
    sendJson(res, 200, {
      workout,
      pendingFile: "data/workout.pending.json",
      feedbackApplied: Boolean(feedbackText),
    });
  } catch (err) {
    console.error("Workout modification failed:", err.message);
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

function handleConfirmWorkout(res) {
  const pending = readJsonFile("data/workout.pending.json");
  if (!pending || !Array.isArray(pending.exercises)) {
    return sendJson(res, 404, { error: "No pending workout to confirm" });
  }
  fs.writeFileSync(WORKOUT_FILE, JSON.stringify(pending, null, 2) + "\n");
  fs.rmSync(PENDING_WORKOUT_FILE, { force: true });
  console.log("Confirmed workout: data/workout.pending.json replaced data/workout.json");
  sendJson(res, 200, { workout: pending, savedTo: "data/workout.json" });
}

function handleDiscardWorkout(res) {
  fs.rmSync(PENDING_WORKOUT_FILE, { force: true });
  sendJson(res, 200, { ok: true });
}

function handleGetPendingWorkout(res) {
  const pending = readJsonFile("data/workout.pending.json");
  if (!pending || !Array.isArray(pending.exercises)) {
    return sendJson(res, 404, { error: "No pending workout" });
  }
  sendJson(res, 200, { workout: pending });
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
  const body = await readBody(req);
  return withSessionLock(sessionId, () => appendMessageLocked(res, sessionId, body));
}

function appendMessageLocked(res, sessionId, { role, type, content, workout, request, status }) {
  const session = readSession(sessionId);
  if (!session) {
    return sendJson(res, 404, { error: "Session not found" });
  }
  if (typeof content !== "string" || !content.trim()) {
    return sendJson(res, 400, { error: "content is required" });
  }
  if (role && !["user", "assistant"].includes(role)) {
    return sendJson(res, 400, { error: "Invalid role" });
  }
  if (status && !["pending", "confirmed", "rejected"].includes(status)) {
    return sendJson(res, 400, { error: "Invalid status" });
  }
  const message = { content: content.trim(), createdAt: new Date().toISOString() };
  if (role) message.role = role;
  if (type) message.type = type;
  if (status) message.status = status;
  if (typeof request === "string" && request.trim()) message.request = request.trim();
  if (workout && typeof workout === "object" && Array.isArray(workout.exercises)) {
    message.workout = workout;
  }
  session.messages.push(message);
  session.updatedAt = message.createdAt;
  writeSession(session);
  sendJson(res, 200, { ...message, index: session.messages.length - 1 });
}

const MESSAGE_STATUSES = ["pending", "confirmed", "rejected"];

async function handleUpdateMessage(req, res, sessionId, index) {
  const body = await readBody(req);
  return withSessionLock(sessionId, () => updateMessageLocked(res, sessionId, index, body));
}

function updateMessageLocked(res, sessionId, index, { status }) {
  const session = readSession(sessionId);
  if (!session) {
    return sendJson(res, 404, { error: "Session not found" });
  }
  if (!Number.isInteger(index) || index < 0 || index >= session.messages.length) {
    return sendJson(res, 404, { error: "Message not found" });
  }
  if (!MESSAGE_STATUSES.includes(status)) {
    return sendJson(res, 400, { error: "Invalid status" });
  }
  session.messages[index].status = status;
  session.updatedAt = new Date().toISOString();
  writeSession(session);
  sendJson(res, 200, { ok: true, index, status });
}

function handleDeleteSession(res, sessionId) {
  return withSessionLock(sessionId, () => {
    const session = readSession(sessionId);
    if (!session) {
      return sendJson(res, 404, { error: "Session not found" });
    }
    fs.unlinkSync(path.join(SESSIONS_DIR, `${sessionId}.json`));
    sendJson(res, 200, { ok: true });
  });
}

async function handleRenameSession(req, res, sessionId) {
  const body = await readBody(req);
  return withSessionLock(sessionId, () => renameSessionLocked(res, sessionId, body));
}

function renameSessionLocked(res, sessionId, { title }) {
  const session = readSession(sessionId);
  if (!session) {
    return sendJson(res, 404, { error: "Session not found" });
  }
  if (typeof title !== "string" || !title.trim()) {
    return sendJson(res, 400, { error: "title is required" });
  }
  session.title = title.trim().slice(0, 60);
  session.updatedAt = new Date().toISOString();
  writeSession(session);
  sendJson(res, 200, { ok: true });
}

// Only these files are public. Never resolve arbitrary request paths against
// the project directory, which also contains API keys, Git metadata and chats.
const PUBLIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/script.js", "script.js"],
  ["/data/user.json", "data/user.json"],
  ["/data/workout.json", "data/workout.json"],
]);

function serveStatic(req, res, pathname) {
  const file = PUBLIC_FILES.get(pathname);
  const filePath = file && path.join(__dirname, file);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

const AI_HANDLERS = new Map([
  ["/api/classify", handleClassify],
  ["/api/create-workout", handleCreateWorkout],
  ["/api/modify-workout", handleModifyWorkout],
  ["/api/give-workout-advice", handleGiveWorkoutAdvice],
]);

// The sole upstream process is trusted only on loopback, behind Nginx's login.
// Enforce the shared paid-request budget here, after proxy authentication,
// using the very same parsed pathname and method that select the handler.
// Refill at 12 requests/minute; allow one request plus four excess in a burst.
const AI_BURST_CAPACITY = 5;
const AI_REFILL_MS = 5000;
let aiTokens = AI_BURST_CAPACITY;
let aiRefilledAt = performance.now();

function consumeAiBudget() {
  const now = performance.now();
  aiTokens = Math.min(AI_BURST_CAPACITY, aiTokens + (now - aiRefilledAt) / AI_REFILL_MS);
  aiRefilledAt = now;
  if (aiTokens < 1) return Math.ceil((1 - aiTokens) * AI_REFILL_MS / 1000);
  aiTokens -= 1;
  return 0;
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  } catch {
    // Both the request target and Host header are untrusted URL input.
    return sendJson(res, 400, { error: "Invalid request URL" });
  }
  try {
    const sessionMatch = pathname.match(/^\/api\/sessions\/(\d+)\/messages$/) || pathname.match(/^\/api\/sessions\/(\d+)$/);
    const messageMatch = pathname.match(/^\/api\/sessions\/(\d+)\/messages\/(\d+)$/);
    const aiHandler = req.method === "POST" && AI_HANDLERS.get(pathname);
    if (aiHandler) {
      const retryAfter = consumeAiBudget();
      if (retryAfter) {
        res.setHeader("Retry-After", String(retryAfter));
        return sendJson(res, 429, { error: "Too many AI requests. Try again shortly." });
      }
      return await aiHandler(req, res);
    }
    if (req.method === "POST" && pathname === "/api/confirm-workout") return handleConfirmWorkout(res);
    if (req.method === "DELETE" && pathname === "/api/confirm-workout") return handleDiscardWorkout(res);
    if (req.method === "GET" && pathname === "/api/pending-workout") return handleGetPendingWorkout(res);
    if (req.method === "GET" && pathname === "/api/sessions") return sendJson(res, 200, { sessions: listSessions() });
    if (req.method === "POST" && pathname === "/api/sessions") return await handleCreateSession(req, res);
    if (req.method === "PATCH" && messageMatch) {
      return await handleUpdateMessage(req, res, messageMatch[1], Number(messageMatch[2]));
    }
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

// Nginx handles public HTTPS and authentication. Never expose this upstream
// directly on a network interface, where it would bypass that protection.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`SpotMe running at http://localhost:${PORT}`);
});
