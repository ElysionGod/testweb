const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  mailbox: null,
  timer: null,
  currentMessage: null
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();

  try {
    state.config = await api("/api/config");
    fillDomains(state.config.domains || []);
  } catch (error) {
    showCreateError("Could not load domain configuration.");
  }

  restoreMailbox();
  if (state.mailbox) {
    showInbox();
    await refreshInbox();
    startAutoRefresh();
  }
}

function bindEvents() {
  $("createForm").addEventListener("submit", createInbox);
  $("randomBtn").addEventListener("click", () => {
    $("nameInput").value = randomName();
    $("nameInput").focus();
  });

  $("copyBtn").addEventListener("click", async () => {
    if (!state.mailbox) return;
    await navigator.clipboard.writeText(state.mailbox.address);
    flashButton($("copyBtn"), "Copied");
  });

  $("refreshBtn").addEventListener("click", refreshInbox);
  $("newInboxBtn").addEventListener("click", destroyInbox);
  $("closeReader").addEventListener("click", closeReader);

  $("copyCodeBtn").addEventListener("click", async () => {
    const code = $("primaryCode").textContent.trim();
    if (!code) return;
    await navigator.clipboard.writeText(code);
    flashButton($("copyCodeBtn"), "Copied");
  });

  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => switchReaderView(tab.dataset.view));
  });
}

function fillDomains(domains) {
  const select = $("domainSelect");
  select.innerHTML = "";
  for (const domain of domains) {
    const option = document.createElement("option");
    option.value = domain;
    option.textContent = domain;
    select.appendChild(option);
  }

  if (!domains.length) {
    const option = document.createElement("option");
    option.textContent = "Configure MAIL_DOMAINS first";
    option.disabled = true;
    option.selected = true;
  }
}

async function createInbox(event) {
  event.preventDefault();
  hideCreateError();

  const name = $("nameInput").value.trim();
  const domain = $("domainSelect").value;

  try {
    const mailbox = await api("/api/mailboxes", {
      method: "POST",
      body: JSON.stringify({ name, domain })
    });

    state.mailbox = mailbox;
    localStorage.setItem("olch_mailbox", JSON.stringify(mailbox));
    showInbox();
    await refreshInbox();
    startAutoRefresh();
  } catch (error) {
    showCreateError(error.message || "Could not create inbox.");
  }
}

function showInbox() {
  if (!state.mailbox) return;

  $("createCard").hidden = true;
  $("inboxApp").hidden = false;
  $("reader").hidden = true;
  $("activeAddress").textContent = state.mailbox.address;
  updateExpiry();
}

async function refreshInbox() {
  if (!state.mailbox) return;

  setStatus("Refreshing…", false);

  try {
    const data = await api(
      `/api/mailboxes/${encodeURIComponent(state.mailbox.id)}/messages`,
      { token: state.mailbox.token }
    );

    state.mailbox.expiresAt = data.mailbox.expiresAt;
    localStorage.setItem("olch_mailbox", JSON.stringify(state.mailbox));

    renderMessages(data.messages || []);
    updateExpiry();
    setStatus("Listening for new mail…", true);
  } catch (error) {
    if (/expired|not found/i.test(error.message)) {
      clearMailbox();
      return;
    }
    setStatus("Connection problem", false, true);
  }
}

function renderMessages(messages) {
  $("messageCount").textContent = messages.length;
  $("emptyState").hidden = messages.length > 0;

  const list = $("messageList");
  list.innerHTML = "";

  for (const msg of messages) {
    const row = document.createElement("div");
    row.className = "message-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");

    const left = document.createElement("div");
    const sender = document.createElement("div");
    sender.className = "message-sender";
    sender.textContent = msg.sender;

    const subject = document.createElement("div");
    subject.className = "message-subject";
    subject.textContent = msg.subject || "(No subject)";

    left.append(sender, subject);

    if (Array.isArray(msg.codes) && msg.codes.length) {
      const chips = document.createElement("div");
      chips.className = "code-chips";
      for (const item of msg.codes.slice(0, 3)) {
        const chip = document.createElement("span");
        chip.className = "code-chip";
        chip.textContent = item.code;
        chips.appendChild(chip);
      }
      left.appendChild(chips);
    }

    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = formatRelative(msg.receivedAt);

    row.append(left, time);
    row.addEventListener("click", () => openMessage(msg.id));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openMessage(msg.id);
    });

    list.appendChild(row);
  }
}

async function openMessage(id) {
  if (!state.mailbox) return;

  try {
    const msg = await api(`/api/messages/${encodeURIComponent(id)}`, {
      token: state.mailbox.token
    });

    state.currentMessage = msg;
    $("inboxApp").hidden = true;
    $("reader").hidden = false;
    $("readerSender").textContent = msg.sender;
    $("readerSubject").textContent = msg.subject || "(No subject)";
    $("readerDate").textContent = new Date(msg.receivedAt * 1000).toLocaleString();
    $("textView").textContent = msg.text || "No plain-text body.";

    const primary = Array.isArray(msg.codes) && msg.codes.length ? msg.codes[0].code : "";
    $("codePanel").hidden = !primary;
    $("primaryCode").textContent = primary;

    $("htmlView").srcdoc = sanitizeEmailHtml(msg.html || "<p>No HTML version.</p>");
    switchReaderView("text");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    alert(error.message || "Could not open message.");
  }
}

function closeReader() {
  $("reader").hidden = true;
  $("inboxApp").hidden = false;
  state.currentMessage = null;
}

function switchReaderView(view) {
  const html = view === "html";
  $("textView").hidden = html;
  $("htmlView").hidden = !html;

  document.querySelectorAll(".tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.view === view);
  });
}

function sanitizeEmailHtml(input) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(input || ""), "text/html");

  doc.querySelectorAll("script,iframe,object,embed,form,input,button,textarea,select,meta,base,link,style").forEach(el => el.remove());

  doc.querySelectorAll("*").forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();

      if (name.startsWith("on") || name === "style" || name === "srcdoc") {
        el.removeAttribute(attr.name);
        continue;
      }

      if (name === "src") {
        if (!value.startsWith("data:image/")) el.removeAttribute(attr.name);
      }

      if (name === "href") {
        if (!/^https?:\/\//i.test(value)) {
          el.removeAttribute(attr.name);
        } else {
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
        }
      }
    }
  });

  const safeCss = `
    body{font-family:Arial,sans-serif;line-height:1.5;color:#171717;padding:22px;max-width:850px;margin:auto}
    img{max-width:100%;height:auto}
    a{color:#5b3cc4}
    table{max-width:100%}
  `;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${safeCss}</style></head><body>${doc.body.innerHTML}</body></html>`;
}

async function destroyInbox() {
  if (!state.mailbox) return;

  try {
    await api(`/api/mailboxes/${encodeURIComponent(state.mailbox.id)}`, {
      method: "DELETE",
      token: state.mailbox.token
    });
  } catch {
    // Clear locally even if the server inbox has already expired.
  }

  clearMailbox();
}

function clearMailbox() {
  stopAutoRefresh();
  state.mailbox = null;
  state.currentMessage = null;
  localStorage.removeItem("olch_mailbox");
  $("inboxApp").hidden = true;
  $("reader").hidden = true;
  $("createCard").hidden = false;
  $("messageList").innerHTML = "";
  $("messageCount").textContent = "0";
  $("emptyState").hidden = false;
}

function restoreMailbox() {
  try {
    const raw = localStorage.getItem("olch_mailbox");
    if (!raw) return;
    const mailbox = JSON.parse(raw);
    if (!mailbox?.id || !mailbox?.token || !mailbox?.address) return;
    if (mailbox.expiresAt && mailbox.expiresAt <= Math.floor(Date.now() / 1000)) {
      localStorage.removeItem("olch_mailbox");
      return;
    }
    state.mailbox = mailbox;
  } catch {
    localStorage.removeItem("olch_mailbox");
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.timer = setInterval(refreshInbox, 4000);
}

function stopAutoRefresh() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function updateExpiry() {
  if (!state.mailbox?.expiresAt) return;
  const seconds = Math.max(0, state.mailbox.expiresAt - Math.floor(Date.now() / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  $("expiryText").textContent = `Expires in ${h}h ${m}m`;
}

function setStatus(text, good = false, bad = false) {
  $("statusText").textContent = text;
  $("statusDot").style.background = bad ? "#ff6b7a" : good ? "#55d98a" : "#e9b949";
}

function formatRelative(timestamp) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(timestamp || 0));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function randomName() {
  const a = ["nova","ghost","void","orbit","neon","pixel","echo","zero","nox","flux"];
  const b = Math.floor(1000 + Math.random() * 9000);
  return `${a[Math.floor(Math.random() * a.length)]}${b}`;
}

function flashButton(button, text) {
  const old = button.textContent;
  button.textContent = text;
  setTimeout(() => button.textContent = old, 1200);
}

function showCreateError(message) {
  $("createError").textContent = message;
  $("createError").hidden = false;
}

function hideCreateError() {
  $("createError").hidden = true;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("content-type", "application/json");
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body
  });

  let data = {};
  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}
