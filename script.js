const sidebarItems = document.querySelectorAll(".sidebar-item");
const views = document.querySelectorAll(".view");

const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");
const chatEmptyState = document.getElementById("chat-empty-state");
const chatSessionList = document.getElementById("chat-session-list");
const newSessionBtn = document.getElementById("new-session-btn");
const chatSendBtn = document.getElementById("chat-send-btn");

const CLASSIFY_API_URL = "/api/classify";
const CREATE_WORKOUT_API_URL = "/api/create-workout";
const MODIFY_WORKOUT_API_URL = "/api/modify-workout";
const CONFIRM_WORKOUT_API_URL = "/api/confirm-workout";
const SESSIONS_API_URL = "/api/sessions";

let currentSession = null;
let sessions = [];

loadWorkout();
loadProfile();
loadSessions();

sidebarItems.forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();

    const view = item.dataset.view;

    if (view === "coach" && item.classList.contains("active")) {
      startNewSession();
      return;
    }

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
  fetch("data/workout.json", { cache: "no-store" })
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

function activateView(view) {
  const target = [...sidebarItems].find((item) => item.dataset.view === view);
  if (!target) return;
  sidebarItems.forEach((i) => i.classList.toggle("active", i === target));
  views.forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
}

function switchToWorkoutView() {
  activateView("workout");
}
// Profile view

const profileRoot = document.getElementById("profile-root");

function loadProfile() {
  fetch("data/user.json")
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load profile (${res.status})`);
      return res.json();
    })
    .then((data) => renderProfile(data))
    .catch((err) => {
      profileRoot.innerHTML = "";
      const error = document.createElement("p");
      error.classList.add("chat-disclaimer");
      error.textContent = `Could not load profile: ${err.message}`;
      profileRoot.appendChild(error);
    });
}

function renderProfile(user) {
  profileRoot.innerHTML = "";

  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const heightCm = user.height?.cm;
  const weightKg = user.weight?.kg;
  const bmi =
    heightCm && weightKg
      ? (weightKg / Math.pow(heightCm / 100, 2)).toFixed(1)
      : null;

  const header = document.createElement("div");
  header.classList.add("profile-header");

  const avatar = document.createElement("div");
  avatar.classList.add("profile-avatar");
  avatar.textContent = initials;

  const identity = document.createElement("div");
  identity.classList.add("profile-identity");

  const name = document.createElement("h1");
  name.classList.add("profile-name");
  name.textContent = user.name;

  const badges = document.createElement("div");
  badges.classList.add("profile-badges");

  const experience = document.createElement("span");
  experience.classList.add("profile-badge");
  experience.textContent = user.experienceLevel;

  const units = document.createElement("span");
  units.classList.add("profile-badge");
  units.textContent =
    user.preferences?.units === "metric" ? "Metric (kg/cm)" : "Imperial (lb/ft)";

  badges.append(experience, units);
  identity.append(name, badges);
  header.append(avatar, identity);
  profileRoot.appendChild(header);

  const stats = document.createElement("div");
  stats.classList.add("profile-stats");

  const statData = [
    { label: "Height", value: heightCm ? `${heightCm} cm` : "—" },
    { label: "Weight", value: weightKg ? `${weightKg} kg` : "—" },
    { label: "BMI", value: bmi ?? "—" },
    {
      label: "Workout Days",
      value: user.preferences?.workoutDaysPerWeek
        ? `${user.preferences.workoutDaysPerWeek} / week`
        : "—",
    },
  ];

  statData.forEach(({ label, value }) => {
    const stat = document.createElement("div");
    stat.classList.add("profile-stat");

    const statLabel = document.createElement("div");
    statLabel.classList.add("profile-stat-label");
    statLabel.textContent = label;

    const statValue = document.createElement("div");
    statValue.classList.add("profile-stat-value");
    statValue.textContent = value;

    stat.append(statLabel, statValue);
    stats.appendChild(stat);
  });

  profileRoot.appendChild(stats);

  const columns = document.createElement("div");
  columns.classList.add("profile-columns");

  columns.appendChild(
    renderProfileCard("Goals", user.goals || [], (goal) => goal)
  );

  const preferencesList = [];
  if (user.preferences?.equipmentAccess) {
    preferencesList.push({
      title: "Equipment Access",
      items: user.preferences.equipmentAccess,
    });
  }
  if (user.preferences?.preferredMuscleGroups) {
    preferencesList.push({
      title: "Preferred Muscle Groups",
      items: user.preferences.preferredMuscleGroups,
    });
  }

  const prefsCard = document.createElement("div");
  prefsCard.classList.add("profile-card");

  preferencesList.forEach(({ title, items }) => {
    prefsCard.appendChild(renderProfileSectionTitle(title));
    prefsCard.appendChild(renderChipList(items));
  });

  if (user.preferences?.notifications !== undefined) {
    prefsCard.appendChild(renderProfileSectionTitle("Notifications"));
    const toggleRow = document.createElement("div");
    toggleRow.classList.add("profile-toggle-row");

    const toggleText = document.createElement("span");
    toggleText.classList.add("profile-toggle-text");
    toggleText.textContent = "Workout reminders";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.classList.add("profile-toggle");
    toggle.setAttribute("role", "switch");
    toggle.setAttribute(
      "aria-checked",
      String(Boolean(user.preferences.notifications))
    );
    toggle.classList.toggle("profile-toggle-on", Boolean(user.preferences.notifications));
    const knob = document.createElement("div");
    knob.classList.add("profile-toggle-knob");
    toggle.appendChild(knob);

    toggle.addEventListener("click", () => {
      user.preferences.notifications = !user.preferences.notifications;
      toggle.classList.toggle("profile-toggle-on", user.preferences.notifications);
      toggle.setAttribute("aria-checked", String(user.preferences.notifications));
    });

    toggleRow.append(toggleText, toggle);
    prefsCard.appendChild(toggleRow);
  }

  columns.appendChild(prefsCard);
  profileRoot.appendChild(columns);
}

function renderProfileCard(title, items, format) {
  const card = document.createElement("div");
  card.classList.add("profile-card");
  card.appendChild(renderProfileSectionTitle(title));
  card.appendChild(renderChipList(items.map(format)));
  return card;
}

function renderProfileSectionTitle(title) {
  const heading = document.createElement("h2");
  heading.classList.add("profile-section-title");
  heading.textContent = title;
  return heading;
}

function renderChipList(items) {
  const list = document.createElement("div");
  list.classList.add("profile-chip-list");
  items.forEach((item) => {
    const chip = document.createElement("span");
    chip.classList.add("profile-chip");
    chip.textContent = item;
    list.appendChild(chip);
  });
  return list;
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

newSessionBtn.addEventListener("click", startNewSession);

function startNewSession() {
  currentSession = null;
  renderSessionList();
  clearChatMessages();
  chatInput.focus();
}

function clearChatMessages() {
  chatMessages.innerHTML = "";
  chatEmptyState.style.display = "";
  chatMessages.appendChild(chatEmptyState);
}

const DOTS_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M11 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /></svg>';

const TRASH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 7l16 0" /><path d="M10 11l0 6" /><path d="M14 11l0 6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" /></svg>';

const PENCIL_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" /><path d="M13.5 6.5l4 4" /></svg>';

function closeSessionMenu() {
  document.querySelector(".session-menu")?.remove();
  document.querySelector(".chat-session-menu-btn.menu-open")?.classList.remove("menu-open");
}

function openSessionMenu(anchor, session, item) {
  closeSessionMenu();
  anchor.classList.add("menu-open");
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.classList.add("session-menu");

  const renameItem = document.createElement("button");
  renameItem.type = "button";
  renameItem.classList.add("session-menu-item");
  renameItem.innerHTML = `${PENCIL_ICON}<span>Rename</span>`;
  renameItem.addEventListener("click", () => {
    closeSessionMenu();
    startRename(session, item);
  });

  const deleteItem = document.createElement("button");
  deleteItem.type = "button";
  deleteItem.classList.add("session-menu-item", "danger");
  deleteItem.innerHTML = `${TRASH_ICON}<span>Delete</span>`;
  deleteItem.addEventListener("click", () => {
    closeSessionMenu();
    deleteSession(session.id);
  });

  menu.append(renameItem, deleteItem);
  document.body.appendChild(menu);

  const menuRect = menu.getBoundingClientRect();
  let left = rect.right + 4;
  if (left + menuRect.width > window.innerWidth) {
    left = window.innerWidth - menuRect.width - 8;
  }
  let top = rect.top + (rect.height - menuRect.height) / 2;
  if (top + menuRect.height > window.innerHeight) {
    top = window.innerHeight - menuRect.height - 8;
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  setTimeout(() => {
    document.addEventListener("click", closeSessionMenu, { once: true });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSessionMenu();
    }, { once: true });
  });
}

function renderSessionList() {
  closeSessionMenu();
  chatSessionList.innerHTML = "";
  sessions.forEach((session) => {
    const item = document.createElement("li");
    item.classList.add("chat-session-item");
    if (currentSession?.id === session.id) item.classList.add("active");

    const title = document.createElement("span");
    title.classList.add("chat-session-title");
    title.textContent = session.title;

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.classList.add("chat-session-menu-btn");
    menuBtn.setAttribute("aria-label", "Session options");
    menuBtn.setAttribute("aria-haspopup", "true");
    menuBtn.innerHTML = DOTS_ICON;
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.querySelector(".session-menu");
      if (menu) closeSessionMenu();
      else openSessionMenu(menuBtn, session, item);
    });

    item.addEventListener("click", () => switchSession(session.id));
    item.append(title, menuBtn);
    chatSessionList.appendChild(item);
  });
}

async function loadSessions() {
  try {
    const res = await fetch(SESSIONS_API_URL);
    if (!res.ok) return;
    sessions = (await res.json()).sessions || [];
    renderSessionList();
  } catch {
    // leave sidebar empty if the store is unreachable
  }
}

async function deleteSession(id) {
  try {
    const res = await fetch(`${SESSIONS_API_URL}/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Failed to delete session (${res.status})`);
    sessions = sessions.filter((session) => session.id !== id);
    if (currentSession?.id === id) startNewSession();
    else renderSessionList();
  } catch {
    // keep the list as-is if deletion fails
  }
}

async function renameSession(id, title) {
  try {
    const res = await fetch(`${SESSIONS_API_URL}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`Failed to rename session (${res.status})`);
    sessions = sessions.map((session) => (session.id === id ? { ...session, title } : session));
    renderSessionList();
  } catch {
    // keep the old title if renaming fails
  }
}

function startRename(session, item) {
  const titleEl = item.querySelector(".chat-session-title");
  const input = document.createElement("input");
  input.type = "text";
  input.classList.add("chat-session-rename-input");
  input.value = session.title;
  input.maxLength = 60;
  item.replaceChild(input, titleEl);
  input.focus();
  input.select();
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      input.value = session.title;
      input.blur();
    }
  });
  input.addEventListener("blur", () => {
    const newTitle = input.value.trim();
    input.replaceWith(titleEl);
    if (newTitle && newTitle !== session.title) renameSession(session.id, newTitle);
  });
}

async function switchSession(id) {
  if (currentSession?.id === id) return;
  try {
    const res = await fetch(`${SESSIONS_API_URL}/${id}`);
    if (!res.ok) throw new Error(`Failed to load session (${res.status})`);
    currentSession = await res.json();
    renderSessionList();
    renderSession(currentSession);
    activateView("coach");
  } catch {
    // keep the current view if loading fails
  }
}

async function renderSession(session) {
  chatMessages.innerHTML = "";
  if (session.messages.length) {
    chatEmptyState.style.display = "none";
  } else {
    chatEmptyState.style.display = "";
    chatMessages.appendChild(chatEmptyState);
  }
  const pendingData = await fetchPendingWorkout();
  const feedbackAfter = new Set();
  let lastProposalIndex = null;
  session.messages.forEach((message, index) => {
    if (message.type === "proposal" && message.workout) lastProposalIndex = index;
    else if (message.role === "user" && lastProposalIndex != null) {
      feedbackAfter.add(lastProposalIndex);
    }
  });
  session.messages.forEach((message, index) => {
    if (message.type === "classification") renderClassification(message.content);
    else if (message.type === "proposal" && message.workout) {
      let status = message.status || "pending";
      if (status === "pending" && pendingData?.workout?.id !== message.workout.id) {
        status = "completed";
      }
      if (status === "pending" && feedbackAfter.has(index)) {
        status = "completed";
      }
      renderWorkoutProposal(
        message.request || "Modify workout",
        null,
        message.workout,
        { index, status }
      );
    } else renderMessage(message.role, message.content);
  });
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function fetchPendingWorkout() {
  try {
    const res = await fetch("/api/pending-workout");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function createSession(title) {
  const res = await fetch(SESSIONS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title.slice(0, 60) }),
  });
  if (!res.ok) throw new Error(`Failed to create session (${res.status})`);
  return res.json();
}

async function appendSessionMessage(sessionId, message) {
  const res = await fetch(`${SESSIONS_API_URL}/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error(`Failed to save message (${res.status})`);
  return res.json();
}

const SUGGESTIONS = [
  {
    title: "Create Workout",
    prompt: "Create a 4-day push/pull/legs workout plan for me",
    icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" /><path d="M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" /><path d="M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" /><path d="M14 17h6m-3 -3v6" /></svg>',
  },
  {
    title: "Modify Workout",
    prompt: "Swap barbell squats for goblet squats in my workout",
    icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" /><path d="M13.5 6.5l4 4" /></svg>',
  },
  {
    title: "Give Workout Advice",
    prompt: "How many sets per week should I train each muscle group?",
    icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 10h10" /><path d="M9 14h5" /><path d="M12.4 3a5.34 5.34 0 0 1 4.906 3.239a5.333 5.333 0 0 1 -1.195 10.6a4.26 4.26 0 0 1 -5.28 1.863l-3.831 2.298v-3.134a2.668 2.668 0 0 1 -1.795 -3.773a4.8 4.8 0 0 1 2.908 -8.933a5.33 5.33 0 0 1 4.287 -2.16" /></svg>',
  },
  {
    title: "Analyze Form",
    prompt: "Here is a video of my squat. What should I fix in my form?",
    icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4z" /><path d="M3 6m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z" /></svg>',
  },
];

function createSuggestionGrid() {
  const grid = document.createElement("div");
  grid.classList.add("chat-suggestion-grid");
  SUGGESTIONS.forEach(({ title, prompt, icon }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("chat-suggestion");
    button.dataset.prompt = prompt;

    const iconSpan = document.createElement("span");
    iconSpan.classList.add("chat-suggestion-icon");
    iconSpan.innerHTML = icon;

    const titleSpan = document.createElement("span");
    titleSpan.classList.add("chat-suggestion-title");
    titleSpan.textContent = title;

    const exampleSpan = document.createElement("span");
    exampleSpan.classList.add("chat-suggestion-example");
    exampleSpan.textContent = `"${prompt}"`;

    button.append(iconSpan, titleSpan, exampleSpan);
    grid.appendChild(button);
  });
  grid.addEventListener("click", (e) => {
    const button = e.target.closest(".chat-suggestion");
    if (!button) return;
    chatInput.value = button.dataset.prompt;
    sendMessage();
  });
  return grid;
}

document.getElementById("chat-suggestion-slot").appendChild(createSuggestionGrid());

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatMessages.querySelectorAll(".chat-suggestion-grid").forEach((grid) => {
    if (grid.parentElement !== chatEmptyState) grid.remove();
  });

  renderMessage("user", text);

  chatInput.value = "";
  chatInput.style.height = "auto";
  chatInput.focus();

  (async () => {
    if (!currentSession) {
      try {
        currentSession = await createSession(text);
        await loadSessions();
      } catch {
        currentSession = null;
      }
    }
    if (currentSession) {
      appendSessionMessage(currentSession.id, { role: "user", content: text }).catch(() => {});
    }
    await classifyMessage(text);
  })();
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
  const save = (message) =>
    currentSession
      ? appendSessionMessage(currentSession.id, message).catch(() => {})
      : Promise.resolve();
  try {
    const res = await fetch(CLASSIFY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Classification failed");
    if (data.relevant === false) {
      const reply =
        "That doesn't look like a relevant message type. I can help you create a workout, modify a workout, give workout advice, or analyze exercise form. Try asking about one of those.";
      renderMessage("assistant", reply);
      await save({ role: "assistant", content: reply });
      chatMessages.appendChild(createSuggestionGrid());
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return;
    }
    if (!data.label) throw new Error("Classification failed");
    renderClassification(data.label);
    await save({ type: "classification", content: data.label });
    if (data.label === "Create Workout") await runCreateWorkout(text, save);
    if (data.label === "Modify Workout") await runModifyWorkout(text, save);
  } catch (err) {
    renderClassification("Unclassified");
    await save({ type: "classification", content: "Unclassified" });
  }
}

function setChatBusy(busy) {
  chatInput.disabled = busy;
  chatSendBtn.disabled = busy;
}

async function runCreateWorkout(text, save) {
  const pending = renderMessage(
    "assistant",
    "Generating your workout. I'm picking exercises from the catalog to fit your profile..."
  );
  pending.classList.add("chat-pending");
  try {
    const res = await fetch(CREATE_WORKOUT_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, sessionId: currentSession?.id }),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Workout service returned an unexpected response (${res.status})`);
    }
    if (!res.ok) throw new Error(data.error || `Workout generation failed (${res.status})`);
    const exercises = data.workout.exercises;
    pending.textContent = `Done! Your new workout "${data.workout.name}" is ready with ${exercises.length} exercises.`;
    pending.classList.remove("chat-pending");
    save({ role: "assistant", content: pending.textContent }).catch(() => {});

    const link = document.createElement("a");
    link.href = "#";
    link.classList.add("chat-workout-link");
    link.textContent = "View your workout";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      loadWorkout();
      switchToWorkoutView();
    });
    chatMessages.appendChild(link);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    loadWorkout();
  } catch (err) {
    pending.textContent = `I couldn't generate your workout: ${err.message}`;
    pending.classList.remove("chat-pending");
    save({ role: "assistant", content: pending.textContent }).catch(() => {});
  }
}

async function runModifyWorkout(requestText, save, feedback) {
  save = save || (() => Promise.resolve());
  const pending = renderMessage(
    "assistant",
    feedback
      ? "Revising your workout based on your feedback..."
      : "Updating your workout based on your request..."
  );
  pending.classList.add("chat-pending");
  try {
    const res = await fetch(MODIFY_WORKOUT_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: requestText, feedback, sessionId: currentSession?.id }),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Workout service returned an unexpected response (${res.status})`);
    }
    if (!res.ok) throw new Error(data.error || `Workout modification failed (${res.status})`);
    pending.textContent = feedback
      ? "Here is the revised version:"
      : "Here is the proposed change to your workout:";
    pending.classList.remove("chat-pending");
    await save({ role: "assistant", content: pending.textContent });
    renderWorkoutProposal(requestText, save, data.workout);
  } catch (err) {
    pending.textContent = `I couldn't modify your workout: ${err.message}`;
    pending.classList.remove("chat-pending");
    save({ role: "assistant", content: pending.textContent }).catch(() => {});
  }
}

function renderWorkoutProposal(requestText, save, proposal, existing) {
  const messageIndex = existing?.index ?? null;
  const status = existing?.status || (existing ? "pending" : null);
  const isReplay = Boolean(existing);
  const actionable = !status || status === "pending";

  const summary = `Proposed workout: ${proposal.name} (${proposal.exercises.length} exercises)`;
  const card = document.createElement("div");
  card.classList.add("chat-proposal-card");

  const title = document.createElement("div");
  title.classList.add("chat-proposal-title");
  title.textContent = summary;
  card.appendChild(title);

  if (status === "confirmed" || status === "rejected" || status === "completed") {
    const chip = document.createElement("span");
    chip.classList.add("chat-proposal-status");
    chip.textContent =
      status === "confirmed" ? "Confirmed" : status === "rejected" ? "Rejected" : "Completed";
    card.appendChild(chip);
  }

  const list = document.createElement("ul");
  list.classList.add("chat-proposal-list");
  proposal.exercises.forEach((exercise) => {
    const item = document.createElement("li");
    item.textContent = `${exercise.name} — ${exercise.sets.length} set${exercise.sets.length === 1 ? "" : "s"}`;
    list.appendChild(item);
  });
  card.appendChild(list);

  const jsonDetails = document.createElement("details");
  jsonDetails.classList.add("chat-proposal-json");
  const jsonSummary = document.createElement("summary");
  jsonSummary.textContent = "View proposed workout.json";
  const jsonPre = document.createElement("pre");
  jsonPre.textContent = JSON.stringify(proposal, null, 2);
  jsonDetails.append(jsonSummary, jsonPre);
  card.appendChild(jsonDetails);

  if (actionable) {
    const actions = document.createElement("div");
    actions.classList.add("chat-proposal-actions");

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.classList.add("chat-proposal-confirm");
    confirmBtn.textContent = "Confirm";

    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.classList.add("chat-proposal-reject");
    rejectBtn.textContent = "Reject";

    confirmBtn.addEventListener("click", () => confirmWorkoutProposal(card, save, proposal, requestText, messageIndex));
    rejectBtn.addEventListener("click", () => {
      actions.remove();
      card.appendChild(renderFeedbackForm(requestText, save, messageIndex));
    });

    actions.append(confirmBtn, rejectBtn);
    card.appendChild(actions);
  }

  chatMessages.appendChild(card);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (actionable) setChatBusy(true);

  if (!isReplay && currentSession) {
    appendSessionMessage(currentSession.id, {
      type: "proposal",
      content: summary,
      workout: proposal,
      request: requestText,
      status: "pending",
    }).catch(() => {});
  }
}

async function updateProposalStatus(messageIndex, status) {
  if (messageIndex == null || !currentSession) return;
  try {
    await fetch(`${SESSIONS_API_URL}/${currentSession.id}/messages/${messageIndex}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  } catch {
    // leave the stored status as-is if the update fails
  }
}

async function confirmWorkoutProposal(card, save, proposal, requestText, messageIndex) {
  save = save || (() => Promise.resolve());
  card.querySelectorAll(".chat-proposal-actions, .chat-feedback-form").forEach((el) => el.remove());
  const pending = renderMessage("assistant", "Saving your updated workout...");
  pending.classList.add("chat-pending");
  try {
    const res = await fetch(CONFIRM_WORKOUT_API_URL, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to save workout (${res.status})`);
    pending.textContent = `Done! Your workout "${data.workout.name}" has been updated.`;
    pending.classList.remove("chat-pending");
    setChatBusy(false);
    await save({ role: "assistant", content: pending.textContent });
    await updateProposalStatus(messageIndex, "confirmed");

    const link = document.createElement("a");
    link.href = "#";
    link.classList.add("chat-workout-link");
    link.textContent = "View your workout";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      loadWorkout();
      switchToWorkoutView();
    });
    chatMessages.appendChild(link);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    loadWorkout();
  } catch (err) {
    pending.textContent = `I couldn't save your workout: ${err.message}`;
    pending.classList.remove("chat-pending");
    save({ role: "assistant", content: pending.textContent }).catch(() => {});
    renderWorkoutProposal(requestText, save, proposal);
  }
}

function renderFeedbackForm(requestText, save, messageIndex) {
  setChatBusy(true);
  const form = document.createElement("div");
  form.classList.add("chat-feedback-form");

  const label = document.createElement("p");
  label.classList.add("chat-feedback-label");
  label.textContent = "What should be different in the next version?";
  form.appendChild(label);

  const textarea = document.createElement("textarea");
  textarea.classList.add("chat-feedback-input");
  textarea.rows = 2;
  textarea.placeholder = "e.g. Keep the deadlifts and only swap the bench press";
  form.appendChild(textarea);

  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.classList.add("chat-proposal-confirm");
  sendBtn.textContent = "Send feedback";

  sendBtn.addEventListener("click", () => {
    const feedbackText = textarea.value.trim();
    if (!feedbackText) {
      textarea.focus();
      return;
    }
    form.remove();
    setChatBusy(false);
    renderMessage("user", feedbackText);
    if (currentSession) {
      appendSessionMessage(currentSession.id, { role: "user", content: feedbackText }).catch(() => {});
    }
    updateProposalStatus(messageIndex, "rejected");
    runModifyWorkout(requestText, save, feedbackText);
  });

  form.appendChild(sendBtn);
  chatMessages.appendChild(form);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  textarea.focus();
  return form;
}
