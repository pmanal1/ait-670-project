const sidebarItems = document.querySelectorAll(".sidebar-item");
const views = document.querySelectorAll(".view");

const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");
const chatEmptyState = document.getElementById("chat-empty-state");

const CLASSIFY_API_URL = "/api/classify";

loadWorkout();

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

// Workout view

const workoutList = document.getElementById("workout-list");
const workoutCompleteBtn = document.getElementById("workout-complete-btn");

let workout = null;

workoutCompleteBtn.addEventListener("click", () => {
  workout.exercises.forEach((exercise) => {
    exercise.sets.forEach((set) => {
      set.complete = false;
      set.weight = -1;
      set.reps = -1;
    });
  });
  renderWorkout();
});

function loadWorkout() {
  fetch("data/workout.json")
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load workout (${res.status})`);
      return res.json();
    })
    .then((data) => {
      workout = data;
      renderWorkout();
    })
    .catch((err) => {
      workoutList.innerHTML = "";
      const error = document.createElement("p");
      error.classList.add("chat-disclaimer");
      error.textContent = `Could not load workout: ${err.message}`;
      workoutList.appendChild(error);
    });
}

function renderWorkout() {
  workoutList.innerHTML = "";
  workout.exercises.forEach((exercise) => {
    workoutList.appendChild(renderExerciseCard(exercise));
  });
  updateCompleteButton();
}

function renderExerciseCard(exercise) {
  const card = document.createElement("div");
  card.classList.add("workout-card");
  card.appendChild(renderExerciseHeader(exercise));

  const setsGrid = document.createElement("div");
  setsGrid.classList.add("sets-grid");
  ["Weight", "Reps", "Complete"].forEach((label) => {
    const header = document.createElement("div");
    header.classList.add("sets-grid-header");
    header.textContent = label;
    setsGrid.appendChild(header);
  });

  exercise.sets.forEach((set, index) => {
    const prevComplete = index === 0 || exercise.sets[index - 1].complete;
    const nextComplete = index !== exercise.sets.length - 1 && exercise.sets[index + 1].complete;

    const weightInput = document.createElement("input");
    weightInput.classList.add("sets-weight");
    weightInput.type = "number";
    weightInput.inputMode = "numeric";
    weightInput.placeholder = "lbs";
    weightInput.value = set.weight === -1 ? "" : set.weight;
    weightInput.addEventListener("input", () => {
      set.weight = weightInput.value === "" ? -1 : Number(weightInput.value);
    });

    const repsInput = document.createElement("input");
    repsInput.classList.add("sets-reps");
    repsInput.type = "number";
    repsInput.inputMode = "numeric";
    repsInput.placeholder = set.rir || "3 RIR";
    repsInput.value = set.reps === -1 ? "" : set.reps;
    repsInput.addEventListener("input", () => {
      set.reps = repsInput.value === "" ? -1 : Number(repsInput.value);
    });

    const checkbox = document.createElement("input");
    checkbox.classList.add("sets-check");
    checkbox.type = "checkbox";
    checkbox.checked = set.complete;
    checkbox.disabled = !prevComplete || nextComplete;
    checkbox.addEventListener("click", () => {
      set.complete = !set.complete;
      set.weight = !set.complete ? -1 : set.weight;
      set.reps = !set.complete ? -1 : set.reps;
      renderWorkout();
    });

    const completeCell = document.createElement("div");
    completeCell.classList.add("sets-complete");
    completeCell.appendChild(checkbox);

    setsGrid.append(weightInput, repsInput, completeCell);
  });

  card.appendChild(setsGrid);
  return card;
}

function renderExerciseHeader(exercise) {
  const header = document.createElement("div");
  header.classList.add("workout-card-header");

  const name = document.createElement("div");
  name.classList.add("workout-exercise-name");
  name.textContent = exercise.name;

  const actions = document.createElement("div");
  actions.classList.add("workout-card-actions");

  const infoBtn = document.createElement("button");
  infoBtn.classList.add("workout-icon-btn");
  infoBtn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 9h.01" /><path d="M11 12h1v4h1" /></svg>';

  const videoBtn = document.createElement("button");
  videoBtn.classList.add("workout-icon-btn");
  videoBtn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4z" /><path d="M3 6m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z" /></svg>';

  infoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openModal();
  });
  videoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openModal();
  });

  actions.append(infoBtn, videoBtn);
  header.append(name, actions);
  return header;
}

function updateCompleteButton() {
  const allDone =
    workout.exercises.length > 0 &&
    workout.exercises.every((exercise) =>
      exercise.sets.every((set) => set.complete)
    );
  workoutCompleteBtn.disabled = !allDone;
}

const modalOverlay = document.getElementById("modal-overlay");
const modalCloseBtn = document.getElementById("modal-close-btn");

modalCloseBtn.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

function openModal() {
  modalOverlay.classList.remove("hidden");
}

function closeModal() {
  modalOverlay.classList.add("hidden");
}

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
    if (!res.ok) throw new Error(data.error || "Classification failed");
    if (data.relevant === false) {
      renderMessage(
        "assistant",
        "That doesn't look like a relevant message type. I can help you create a workout, modify a workout, give workout advice, or analyze exercise form. Try asking about one of those."
      );
      return;
    }
    if (!data.label) throw new Error("Classification failed");
    renderClassification(data.label);
  } catch (err) {
    renderClassification("Unclassified");
  }
}
