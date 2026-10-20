const sidebarItems = document.querySelectorAll(".sidebar-item");
const views = document.querySelectorAll(".view");

const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");
const chatEmptyState = document.getElementById("chat-empty-state");

const CLASSIFY_API_URL = "/api/classify";

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
  const text = chatInput.value.trim();
  if (!text) return;

  renderMessage("user", text);

  chatInput.value = "";
  chatInput.style.height = "auto";
  chatInput.focus();

  classifyMessage(text);
}

function renderMessage(role, content) {
  chatEmptyState.style.display = "none";

  const message = document.createElement("div");
  message.classList.add("chat-message", role);
  message.textContent = content;
  chatMessages.appendChild(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return message;
}

function renderClassification(label) {
  chatEmptyState.style.display = "none";

  const badge = document.createElement("div");
  badge.classList.add("chat-classification");
  badge.textContent = label;
  chatMessages.appendChild(badge);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return badge;
}

async function classifyMessage(text) {
  try {
    const res = await fetch(CLASSIFY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok || !data.label) throw new Error(data.error || "Classification failed");
    renderClassification(data.label);
  } catch (err) {
    renderClassification("Unclassified");
  }
}
