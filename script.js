const sidebarItems = document.querySelectorAll(".sidebar-item");
const views = document.querySelectorAll(".view");

const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");
const chatEmptyState = document.getElementById("chat-empty-state");
const chatSendBtn = document.getElementById("chat-send-btn");

const OPENCODE_API_URL = "https://opencode.ai/inference/openai/v1/chat/completions";
const OPENCODE_MODEL = "kimi-k2.6";

// TODO: Fill in OPENCODE_API_KEY from your .env (OPENCODE_API_KEY=...)
// Note: .env values can't be read directly in the browser — this needs to be
// injected at build/serve time, or proxied through a small backend.
const OPENCODE_API_KEY = "oc_sk_920bbea4bc6a_H3ydokC1fI12d_I2FWBPtixPGFbDeeeC";

let chatHistory = [];

sidebarItems.forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();

    const view = item.dataset.view;

    sidebarItems.forEach((i) => i.classList.toggle("active", i === item));
    views.forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  });
});

// Auto-grow textarea as the user types
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 200)}px`;
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});

function sendMessage() {
  // TODO:
  // 1. Read the trimmed text from chatInput
  // 2. If empty, return early
  // 3. Push it into chatHistory as { role: "user", content: text }
  // 4. Render it with renderMessage("user", text)
  // 5. Clear chatInput and reset its height
  // 6. Call getCoachResponse() and handle the result
}

function renderMessage(role, content) {
  // TODO:
  // 1. Hide chatEmptyState now that there's a message
  // 2. Create a div with class "chat-message" plus the role
  //    ("user" or "assistant") and set its textContent to content
  // 3. Append it to chatMessages and scroll chatMessages to the bottom
}

function showTypingIndicator() {
  // TODO:
  // Append an assistant message with the class "typing" saying "Coach is
  // thinking..." and return the element so it can be removed later
}

async function getCoachResponse(historyMessages) {
  // TODO:
  // 1. Call showTypingIndicator() to show the waiting bubble
  // 2. POST to OPENCODE_API_URL with:
  //    {
  //      "Authorization": `Bearer ${OPENCODE_API_KEY}`,
  //      "Content-Type": "application/json"
  //    }
  //    and body: { model: OPENCODE_MODEL, messages: historyMessages }
  // 3. Parse the JSON and pull the reply out of
  //    response.choices[0].message.content
  // 4. Remove the typing indicator
  // 5. Push the reply into chatHistory as { role: "assistant", content: reply }
  // 6. Render it with renderMessage("assistant", reply)
  // 7. On failure, remove the indicator and render an error message instead
}
