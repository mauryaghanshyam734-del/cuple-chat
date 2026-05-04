const joinForm = document.querySelector("#joinForm");
const chatPanel = document.querySelector("#chatPanel");
const messagesEl = document.querySelector("#messages");
const messageForm = document.querySelector("#messageForm");
const messageInput = document.querySelector("#messageInput");
const nameInput = document.querySelector("#nameInput");
const roomInput = document.querySelector("#roomInput");
const makeCode = document.querySelector("#makeCode");
const copyRoom = document.querySelector("#copyRoom");
const statusEl = document.querySelector("#status");
const typingEl = document.querySelector("#typing");

const url = new URL(window.location.href);
const hash = new URLSearchParams(window.location.hash.slice(1));

let state = {
  name: localStorage.getItem("couple-chat-name") || "",
  room: url.searchParams.get("room") || localStorage.getItem("couple-chat-room") || "",
  inviteCode: "",
  keyText: hash.get("key") || "",
  cryptoKey: null,
  events: null,
  messages: new Map(),
  typingTimer: null,
  seenTimer: null,
};

nameInput.value = state.name;
roomInput.value = state.room;

function parseInvite(value) {
  const raw = String(value || "").trim();
  try {
    const parsed = new URL(raw);
    const room = parsed.searchParams.get("room") || "";
    const parsedHash = new URLSearchParams(parsed.hash.slice(1));
    return { room: cleanCode(room).slice(0, 24), inviteCode: cleanCode(room), keyText: parsedHash.get("key") || "" };
  } catch {
    const code = cleanCode(raw);
    const parts = code.split("-").filter(Boolean);
    const room = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : code;
    return { room: room.slice(0, 24), inviteCode: code, keyText: "" };
  }
}

function cleanCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 80);
}

function bytesToBase64Url(bytes) {
  const text = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function makeCryptoKey() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  state.keyText = bytesToBase64Url(raw);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function importCryptoKey(value) {
  return crypto.subtle.importKey("raw", base64UrlToBytes(value), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function deriveCryptoKey(inviteCode, room) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(inviteCode),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(`couple-chat:${room}`),
      iterations: 210000,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function ensureKey() {
  if (state.cryptoKey) return state.cryptoKey;
  if (!state.inviteCode && state.room) {
    state.inviteCode = localStorage.getItem(`couple-chat-code-${state.room}`) || state.room;
  }
  if (!state.keyText && state.room) {
    state.keyText = localStorage.getItem(`couple-chat-key-${state.room}`) || "";
  }
  if (state.keyText) {
    state.cryptoKey = await importCryptoKey(state.keyText);
  } else if (state.inviteCode) {
    state.cryptoKey = await deriveCryptoKey(state.inviteCode, state.room);
  } else {
    state.cryptoKey = await makeCryptoKey();
  }
  return state.cryptoKey;
}

async function encryptText(text) {
  const key = await ensureKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return JSON.stringify({ v: 1, alg: "AES-GCM", iv: bytesToBase64Url(iv), data: bytesToBase64Url(encrypted) });
}

async function decryptText(value) {
  try {
    const payload = JSON.parse(value);
    if (payload.v !== 1 || !payload.iv || !payload.data) return value;
    const key = await ensureKey();
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(payload.iv) },
      key,
      base64UrlToBytes(payload.data),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    if (String(value).startsWith("{")) return "[Encrypted message - open the correct invite link]";
    return value;
  }
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chunk = (length) =>
    Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => chars[byte % chars.length]).join("");
  return `LOVE-${chunk(4)}-${chunk(4)}-${chunk(4)}`;
}

function inviteLink() {
  const shareUrl = new URL(window.location.href);
  shareUrl.search = "";
  shareUrl.hash = "";
  return shareUrl.toString();
}

function syncUrl() {
  if (!state.room) return;
  const cleanUrl = new URL(window.location.href);
  cleanUrl.search = "";
  cleanUrl.hash = "";
  history.replaceState(null, "", cleanUrl.toString());
}

function saveRoomState() {
  localStorage.setItem("couple-chat-name", state.name);
  localStorage.setItem("couple-chat-room", state.room);
  localStorage.setItem(`couple-chat-code-${state.room}`, state.inviteCode || state.room);
  if (state.keyText) localStorage.setItem(`couple-chat-key-${state.room}`, state.keyText);
}

function copyShareText() {
  if (!state.inviteCode) return "";
  return `Open ${inviteLink()} and enter this secure room code: ${state.inviteCode}`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function showEmpty() {
  if (messagesEl.children.length) return;
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = "No messages yet. Copy the secure room code and send it to your partner.";
  messagesEl.append(empty);
}

function removeEmpty() {
  const empty = messagesEl.querySelector(".empty");
  if (empty) empty.remove();
}

function statusText(message) {
  if (message.sender !== state.name) return "";
  if ((message.seenBy || []).length) return "Seen";
  if ((message.deliveredTo || []).length) return "Delivered";
  return "Sent";
}

function updateMessageStatus(message) {
  const status = messagesEl.querySelector(`[data-status-for="${CSS.escape(message.id)}"]`);
  if (status) status.textContent = statusText(message);
}

function mergeMessage(message) {
  const current = state.messages.get(message.id) || {};
  const merged = { ...current, ...message };
  state.messages.set(message.id, merged);
  updateMessageStatus(merged);
  return merged;
}

function scheduleSeen() {
  clearTimeout(state.seenTimer);
  state.seenTimer = setTimeout(() => {
    if (!state.room || !state.name || document.hidden) return;
    post("/seen", { room: state.room, sender: state.name }).catch(() => {});
  }, 250);
}

async function addMessage(message) {
  message = mergeMessage(message);
  if (messagesEl.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;

  removeEmpty();
  const bubble = document.createElement("article");
  const mine = message.sender === state.name;
  bubble.className = `bubble ${mine ? "mine" : "theirs"}`;
  bubble.dataset.messageId = message.id;

  if (!mine) {
    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent = message.sender;
    bubble.append(sender);
  }

  const text = document.createElement("div");
  text.className = "text";
  text.textContent = await decryptText(message.text);
  bubble.append(text);

  const meta = document.createElement("div");
  meta.className = "meta";

  const time = document.createElement("span");
  time.textContent = formatTime(message.sentAt);
  meta.append(time);

  if (mine) {
    const receipt = document.createElement("span");
    receipt.className = "receipt";
    receipt.dataset.statusFor = message.id;
    receipt.textContent = statusText(message);
    meta.append(receipt);
  }

  bubble.append(meta);
  messagesEl.append(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  if (!mine) scheduleSeen();
}

function connect() {
  if (state.events) state.events.close();

  const params = new URLSearchParams({ room: state.room, name: state.name });
  state.events = new EventSource(`/events?${params}`);

  state.events.addEventListener("ready", async (event) => {
    const data = JSON.parse(event.data);
    messagesEl.innerHTML = "";
    state.messages.clear();
    for (const message of data.messages) await addMessage(message);
    showEmpty();
    statusEl.textContent = `${state.room} - encrypted`;
    scheduleSeen();
  });

  state.events.addEventListener("message", async (event) => {
    await addMessage(JSON.parse(event.data));
  });

  state.events.addEventListener("presence", (event) => {
    const data = JSON.parse(event.data);
    const people = data.count === 1 ? "1 person" : `${data.count} people`;
    const names = (data.names || []).filter((name) => name !== state.name);
    statusEl.textContent = names.length ? `${names.join(", ")} online - encrypted` : `${state.room} - ${people} online`;
  });

  state.events.addEventListener("typing", (event) => {
    const data = JSON.parse(event.data);
    const others = data.names.filter((name) => name !== state.name);
    typingEl.textContent = others.length ? `${others.join(", ")} typing...` : "";
  });

  state.events.addEventListener("receipts", (event) => {
    const data = JSON.parse(event.data);
    (data.messages || []).forEach((message) => mergeMessage(message));
  });

  state.events.onerror = () => {
    statusEl.textContent = `${state.room} - reconnecting...`;
  };
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Request failed");
  return response.json();
}

makeCode.addEventListener("click", async () => {
  state.cryptoKey = null;
  state.keyText = "";
  state.inviteCode = makeRoomCode();
  state.room = parseInvite(state.inviteCode).room;
  roomInput.value = state.inviteCode;
  await ensureKey();
  saveRoomState();
  syncUrl();
  await navigator.clipboard.writeText(copyShareText()).catch(() => {});
  statusEl.textContent = "Secure room code copied";
  roomInput.focus();
});

copyRoom.addEventListener("click", async () => {
  if (!state.room) return;
  await ensureKey();
  syncUrl();
  await navigator.clipboard.writeText(copyShareText());
  statusEl.textContent = "Secure room code copied";
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.name = nameInput.value.trim();
  const invite = parseInvite(roomInput.value);
  state.room = invite.room;
  state.inviteCode = invite.inviteCode || invite.room;
  state.keyText = invite.keyText || state.keyText;
  state.cryptoKey = null;
  if (!state.name || !state.room) return;

  await ensureKey();
  saveRoomState();
  roomInput.value = state.inviteCode || state.room;
  syncUrl();
  joinForm.hidden = true;
  chatPanel.hidden = false;
  messageInput.focus();
  connect();
});

messageInput.addEventListener("input", () => {
  if (!state.room || !state.name) return;
  post("/typing", { room: state.room, sender: state.name, typing: true }).catch(() => {});
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => {
    post("/typing", { room: state.room, sender: state.name, typing: false }).catch(() => {});
  }, 900);
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.value = "";
  const encrypted = await encryptText(text);
  await post("/message", { room: state.room, sender: state.name, text: encrypted });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleSeen();
});

if (state.room) {
  const savedCode = localStorage.getItem(`couple-chat-code-${state.room}`);
  roomInput.value = savedCode || state.room;
  state.inviteCode = savedCode || state.room;
}
