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
├── server.js       # Local Node proxy: serves the app + OpenCode AI endpoints
└── README.md
```

## Usage

1. Fill in your keys in `.env` (see `.env.example`).
2. Run `node server.js` and open http://localhost:5173.

Static serving is restricted to an explicit `PUBLIC_FILES` allowlist in
`server.js`: the page, stylesheet, browser script, profile JSON, and workout
JSON. Add new public assets there explicitly; keep credentials, Git metadata,
and raw session files outside that list.

The Node server binds only to `127.0.0.1`. Public deployments must go through
the authenticated HTTPS proxy in [deploy/nginx/spotme.conf](deploy/nginx/spotme.conf).
See [deployment instructions](deploy/README.md) for the private login, rate
limits, and password changes. Local access on the server itself is trusted.

Run the security regression tests with `node --test tests/*.test.js`. They
cover static-file restrictions and malformed request URLs/Host headers, including
checking that the server keeps responding after rejecting invalid URL input.
They use disposable servers and dummy secrets, without reading your `.env` or
calling an AI provider.

With Nginx and OpenSSL installed, run all checks, including the isolated
HTTPS/authentication integration tests:

```sh
NGINX_BIN=/usr/sbin/nginx node --test tests/*.test.js
```

The Nginx tests use temporary ports and disposable credentials. AI-budget
checks run the real app with dummy data and mocked providers; they never spend
AI credits or read/change the system Nginx configuration. Without `NGINX_BIN`,
those integration tests are explicitly skipped.

Messages sent in the Coach view are classified by Jev (jev-1.13) into one
of: Create Workout, Modify Workout, Give Workout Advice, or Analyze Form, and
the label is shown in the chat.

"Create Workout" prompts generate `data/workout.json` via GLM-5.3-Flash
(OpenCode Go). "Give Workout Advice" prompts get concise advice from
GLM-5.3-Flash using the whole session context; once a session is classified as
advice, every later prompt in that session stays in advice mode.
