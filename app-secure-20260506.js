const joinForm = document.querySelector("#joinForm");
const chatPanel = document.querySelector("#chatPanel");
const messagesEl = document.querySelector("#messages");
const messageForm = document.querySelector("#messageForm");
const messageInput = document.querySelector("#messageInput");
const imageInput = document.querySelector("#imageInput");
const imageButton = document.querySelector("#imageButton");
const nameInput = document.querySelector("#nameInput");
const roomInput = document.querySelector("#roomInput");
const makeCode = document.querySelector("#makeCode");
const copyRoom = document.querySelector("#copyRoom");
const statusEl = document.querySelector("#status");
const typingEl = document.querySelector("#typing");

const url = new URL(window.location.href);
const hash = new URLSearchParams(window.location.hash.slice(1));
const MAX_IMAGE_BYTES = 2_000_000;

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

function cleanCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 80);
}

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

function bytesToBase64Url(bytes) {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 0x8000) {
    binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
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
  if (state.keyText) state.cryptoKey = await importCryptoKey(state.keyText);
  else if (state.inviteCode) state.cryptoKey = await deriveCryptoKey(state.inviteCode, state.room);
  else state.cryptoKey = await makeCryptoKey();
  return state.cryptoKey;
}

async function encryptPayload(payload) {
  const key = await ensureKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return JSON.stringify({ v: 2, alg: "AES-GCM", iv: bytesToBase64Url(iv), data: bytesToBase64Url(encrypted) });
}

async function decryptPayload(value) {
  try {
    const payload = JSON.parse(value);
    if (!payload.iv || !payload.data) return { kind: "text", text: value };
    const key = await ensureKey();
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(payload.iv) },
      key,
      base64UrlToBytes(payload.data),
    );
    const decoded = new TextDecoder().decode(decrypted);
    if (payload.v === 1) return { kind: "text", text: decoded };
    return JSON.parse(decoded);
  } catch {
    if (String(value).startsWith("{")) return { kind: "text", text: "[Encrypted message - wrong room code]" };
    return { kind: "text", text: value };
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
  if (message.deleted) return "Unsent";
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

async function renderMessageBody(message, bubble) {
  const body = bubble.querySelector(".body");
  if (!body) return;
  body.innerHTML = "";

  if (message.deleted) {
    const deleted = document.createElement("div");
    deleted.className = "deleted-text";
    deleted.textContent = "This message was unsent";
    body.append(deleted);
    return;
  }

  const payload = await decryptPayload(message.text);
  if (payload.kind === "image") {
    const image = document.createElement("img");
    image.className = "chat-image";
    image.alt = payload.name || "Encrypted image";
    image.src = `data:${payload.mime || "image/jpeg"};base64,${payload.data}`;
    body.append(image);
    if (payload.caption) {
      const caption = document.createElement("div");
      caption.className = "text caption";
      caption.textContent = payload.caption;
      body.append(caption);
    }
  } else {
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = payload.text || "";
    body.append(text);
  }
}

async function refreshMessage(message) {
  message = mergeMessage(message);
  const bubble = messagesEl.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  if (!bubble) {
    await addMessage(message);
    return;
  }
  await renderMessageBody(message, bubble);
  bubble.classList.toggle("deleted", Boolean(message.deleted));
  const edited = bubble.querySelector(".edited");
  if (edited) edited.hidden = !message.editedAt || message.deleted;
  updateMessageStatus(message);
}

async function addMessage(message) {
  message = mergeMessage(message);
  if (messagesEl.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) {
    await refreshMessage(message);
    return;
  }

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

  const body = document.createElement("div");
  body.className = "body";
  bubble.append(body);
  await renderMessageBody(message, bubble);

  const meta = document.createElement("div");
  meta.className = "meta";

  const time = document.createElement("span");
  time.textContent = formatTime(message.sentAt);
  meta.append(time);

  const edited = document.createElement("span");
  edited.className = "edited";
  edited.textContent = "edited";
  edited.hidden = !message.editedAt || message.deleted;
  meta.append(edited);

  if (mine) {
    const receipt = document.createElement("span");
    receipt.className = "receipt";
    receipt.dataset.statusFor = message.id;
    receipt.textContent = statusText(message);
    meta.append(receipt);

    const controls = document.createElement("div");
    controls.className = "message-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => editMessage(message.id));
    const unsend = document.createElement("button");
    unsend.type = "button";
    unsend.textContent = "Unsend";
    unsend.addEventListener("click", () => unsendMessage(message.id));
    controls.append(edit, unsend);
    bubble.append(controls);
  }

  bubble.append(meta);
  messagesEl.append(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  if (!mine) scheduleSeen();
}

async function editMessage(id) {
  const message = state.messages.get(id);
  if (!message || message.sender !== state.name || message.deleted) return;
  const payload = await decryptPayload(message.text);
  if (payload.kind !== "text") {
    alert("Only text messages can be edited. Unsend this image and send it again.");
    return;
  }
  const next = prompt("Edit message", payload.text || "");
  if (next === null) return;
  const text = next.trim();
  if (!text) return;
  const encrypted = await encryptPayload({ kind: "text", text });
  await post("/edit", { room: state.room, sender: state.name, id, text: encrypted });
}

async function unsendMessage(id) {
  const message = state.messages.get(id);
  if (!message || message.sender !== state.name || message.deleted) return;
  if (!confirm("Unsend this message for everyone?")) return;
  await post("/delete", { room: state.room, sender: state.name, id });
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

  state.events.addEventListener("message_edit", async (event) => {
    await refreshMessage(JSON.parse(event.data));
  });

  state.events.addEventListener("message_delete", async (event) => {
    await refreshMessage(JSON.parse(event.data));
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

async function sendEncryptedPayload(payload) {
  const encrypted = await encryptPayload(payload);
  await post("/message", { room: state.room, sender: state.name, text: encrypted });
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
  state.keyText = invite.keyText || "";
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
  await sendEncryptedPayload({ kind: "text", text });
});

imageButton.addEventListener("click", () => {
  imageInput.click();
});

imageInput.addEventListener("change", async () => {
  const file = imageInput.files && imageInput.files[0];
  imageInput.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    alert("Please select an image file.");
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    alert("Image is too large. Please choose an image under 2 MB.");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const caption = messageInput.value.trim();
  messageInput.value = "";
  await sendEncryptedPayload({
    kind: "image",
    mime: file.type,
    name: file.name,
    data: bytesToBase64Url(bytes).replace(/-/g, "+").replace(/_/g, "/"),
    caption,
  });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleSeen();
});

if (state.room) {
  const savedCode = localStorage.getItem(`couple-chat-code-${state.room}`);
  roomInput.value = savedCode || state.room;
  state.inviteCode = savedCode || state.room;
  if (savedCode) state.keyText = "";
}
