# Spot Me

An AI-powered personal lifting coach that tracks your weightlifting sessions.

## Overview

SpotMe is a workout mobile/website application designed to help users create personalized workout routines and improve their exercise techniques. The user will enter information like their height, weight, fitness goals, equipment access, and experience level to generate a workout plan.
Alternatively, users can upload a video of themselves performing an exercise, and SpotMe will analyze their movement and provide feedback on their form.
The overall goal of Spot Me is to provide users with accessible and personalized workout guidance without requiring a personal trainer by combining personalized workout plans and video-based form feedback.

**Course:** AIT-670

**Team:** Paulo Manalo, Ben Kirch, Charles Obiri-Yeboah

**Semester:** [Fall 2026]

## Project Structure

```
ait-670-project/
├── index.html      
├── styles.css      
├── script.js       
├── server.js       # Node server: Jev classification + Codex Terra generation
└── README.md
```

## Usage

1. Copy `.env.example` to `.env` and fill in `TYPESAFE_API_KEY` for Jev
   classification. `TYPESAFE_API_KEY` and `TYPESAFE_MODEL` can also be supplied
   as process environment variables; those take precedence over `.env`.
2. Install the current [Codex CLI](https://learn.chatgpt.com/docs/non-interactive-mode)
   (tested with 0.167.0), run `codex login`, and choose ChatGPT sign-in using your
   subscription. Check with `codex login status`. Terra requires CLI 0.159.0 or later;
   use a current release for the isolation flags used by this app.
3. Run `node server.js` and open http://localhost:5173.

Generation uses `codex exec -m gpt-6.1-terra` with your saved ChatGPT login and
consumes your Codex subscription allowance. It enforces ChatGPT authentication
and does not fall back to API-key billing. `OPENCODE_GO_API_KEY` is no longer used.
Set `CODEX_BIN` in `.env` if the CLI is not on the server's `PATH`, and optionally
`CODEX_HOME` to select its authentication directory. Do not commit Codex credentials.

Codex runs in a private temporary directory with user configuration, plugins,
shell commands, browser/computer tools, app integrations, hooks and subagents
disabled. It receives the profile, catalog and conversation through stdin, returns
JSON using an output schema, and does not persist a Codex session. Temporary files
are removed after each call. The app still saves its own chats in `sessions/`.
Calls time out after 90 seconds, with at most two generations running at once;
login, quota and CLI failures return a retryable error without CLI diagnostics.

Static serving is restricted to an explicit `PUBLIC_FILES` allowlist in
`server.js`: the page, stylesheet, browser script, profile JSON, and workout
JSON. Add new public assets there explicitly; keep credentials, Git metadata,
and raw session files outside that list.

The Node server binds only to `127.0.0.1`. Public deployments must go through
the authenticated HTTPS proxy in [deploy/nginx/spotme.conf](deploy/nginx/spotme.conf).
See [deployment instructions](deploy/README.md) for the private login, rate
limits, and password changes. Local access on the server itself is trusted.

Run the regression tests with `node --test tests/*.test.js`. They cover
TypeSafe classification, Codex generation, conversation history, output validation,
CLI failures, static-file restrictions and malformed request URLs/Host headers,
including checking that the server keeps responding after rejecting invalid input.
They use disposable servers, a fake CLI and dummy secrets, without
reading your `.env` or calling an AI provider.

With Nginx and OpenSSL installed, run all checks, including the isolated
HTTPS/authentication integration tests:

```sh
NGINX_BIN=/usr/sbin/nginx node --test tests/*.test.js
```

The Nginx tests use temporary ports and disposable credentials. AI-budget
checks run the real app with dummy data and mocked providers; they never spend
AI credits or read/change the system Nginx configuration. Without `NGINX_BIN`,
those integration tests are explicitly skipped.

Messages sent in the Coach view are classified directly by TypeSafe Jev into
one of: Create Workout, Modify Workout, Give Workout Advice, or Analyze Form,
and the label is shown in the chat. One server-side request to
`https://api.typesafe.ai/v1/systemone` asks both whether the message is relevant
(a Noul probability, with the existing 0.5 threshold) and which category fits
(a Choice). When relevance is below 0.5, `/api/classify` returns
`{ "relevant": false }` so the chat can ask for a supported request.

The default model is pinned to `jev-1.13.0`, matching the previous Jev release.
Set `TYPESAFE_MODEL` to another supported model ID or `jev-latest` to follow
TypeSafe's stable releases. The old classification `OPENCODE_API_KEY` and
`jev-1.13-free` fallback are no longer used. See the official
[TypeSafe API reference](https://docs.typesafe.ai/api/system-one) and
[model list](https://docs.typesafe.ai/models).

The TypeSafe account needs API access and prepaid credits. Missing configuration
returns `503`; rejected keys, exhausted credits, rate limits, timeouts (15 seconds),
and invalid provider answers return `502` from `/api/classify`, with no fallback
or automatic paid retries. After setting the key on a deployment, restart the
Node service. Keys stay server-side in `.env` or the service environment and
must never be committed.

"Create Workout" prompts generate `data/workout.json` via Codex Terra.
"Modify Workout" prompts propose a plan in `data/workout.pending.json` for
confirmation. "Give Workout Advice" prompts get concise advice from Terra using
the whole session context; once a session is classified as advice, every later
prompt in that session stays in advice mode.
