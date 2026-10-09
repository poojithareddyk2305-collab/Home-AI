"use strict";

/* ====================================================================
   AI Chatbot frontend
   ==================================================================== */

const STORAGE_KEY = "chatbot_sessions_v1";
const THEME_KEY = "chatbot_theme_v1";
const SYSTEM_PROMPT_KEY = "chatbot_system_prompt_v1";
const TOOLS_KEY = "chatbot_tools_v1";
const AUTH_KEY = "chatbot_auth_v1";

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const inputEl = $("input");
const sendBtn = $("send");
const sessionsEl = $("sessions");
const sessionTitleEl = $("sessionTitle");

let currentAbort = null;
let isGenerating = false;
let pendingAttachment = null; // { type, name, content|dataUrl, truncated }
let searchQuery = "";
let personas = [];
let toolsEnabled = readLS(TOOLS_KEY) !== "off";

function readLS(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

/* ---------------------------------------------------------------- icons */
const svg = (inner, extra = "") =>
  `<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" ${extra}>${inner}</svg>`;
const ICON = {
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  check: svg('<path d="M20 6L9 17l-5-5"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  refresh: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  speaker: svg('<path d="M11 5L6 9H2v6h4l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
  code: svg('<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  user: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  cloud: svg('<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 1 0 6 17.5"/><path d="M6 19h11.5"/>'),
  calc: svg('<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h.01M12 19h.01M16 19h.01"/>'),
  send: '<svg class="icon" viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
  stopBig: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};
const BRAND_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-8Z"/>' +
  '<path d="M9 9.2l1 2.1 2.1 1-2.1 1-1 2.1-1-2.1-2.1-1 2.1-1 1-2.1Z" fill="currentColor" stroke="none"/></svg>';
const TOOL_ICONS = { web_search: ICON.globe, get_weather: ICON.cloud, calculator: ICON.calc };

/* ---------------------------------------------------------------- markdown */
marked.use({
  renderer: {
    link(href, title, text) {
      const t = title ? ` title="${title}"` : "";
      const cite = /^\[\d{1,2}\]$/.test(text) ? ' class="cite"' : "";
      return `<a href="${href}" target="_blank" rel="noopener noreferrer"${cite}${t}>${text}</a>`;
    },
  },
});

function renderMd(text, sources) {
  let t = (text || "").replace(/【(\d{1,2})】/g, "[$1]");
  if (sources && sources.length) {
    t = t.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => (sources[n - 1] ? `[[${n}]](${sources[n - 1].url})` : m));
  }
  return marked.parse(t);
}

function highlightCode(root) {
  if (!window.hljs) return;
  root.querySelectorAll("pre code").forEach((el) => {
    if (el.dataset.highlighted) return;
    try { hljs.highlightElement(el); } catch {}
  });
}

/* ---------------------------------------------------------------- attachments */
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const MAX_ATTACHMENT_CHARS = 30000;
const TEXT_EXTENSIONS = [
  "txt", "md", "csv", "json", "log", "py", "js", "ts", "jsx", "tsx",
  "java", "c", "cpp", "cs", "html", "css", "yml", "yaml", "xml", "sh", "sql",
];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

function readFileAs(file, method) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader[method](file);
  });
}

async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n\n";
    if (text.length > MAX_ATTACHMENT_CHARS) break;
  }
  return text;
}

function renderAttachmentChip() {
  const box = $("attachmentChip");
  box.innerHTML = "";
  if (!pendingAttachment) return;
  const chip = document.createElement("div");
  chip.className = "attachment-chip";
  const icon = document.createElement("span");
  icon.style.display = "flex";
  icon.innerHTML = pendingAttachment.type === "image" ? ICON.image : ICON.file;
  const label = document.createElement("span");
  label.textContent = `${pendingAttachment.name}${pendingAttachment.truncated ? " (truncated)" : ""}`;
  const remove = document.createElement("span");
  remove.className = "remove";
  remove.innerHTML = ICON.close;
  remove.addEventListener("click", () => {
    pendingAttachment = null;
    renderAttachmentChip();
  });
  chip.append(icon, label, remove);
  box.appendChild(chip);
}

const fileInput = $("fileInput");
$("attachBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (!file) return;
  const ext = file.name.split(".").pop().toLowerCase();
  try {
    if (IMAGE_EXTENSIONS.includes(ext)) {
      pendingAttachment = { type: "image", name: file.name, dataUrl: await readFileAs(file, "readAsDataURL") };
      renderAttachmentChip();
      return;
    }
    let text;
    if (ext === "pdf") text = await extractPdfText(file);
    else if (TEXT_EXTENSIONS.includes(ext)) text = await readFileAs(file, "readAsText");
    else {
      alert(`Unsupported file type: .${ext}\nText files, PDFs, and images are supported.`);
      return;
    }
    const truncated = text.length > MAX_ATTACHMENT_CHARS;
    pendingAttachment = {
      type: "text",
      name: file.name,
      content: truncated ? text.slice(0, MAX_ATTACHMENT_CHARS) : text,
      truncated,
    };
    renderAttachmentChip();
  } catch (err) {
    alert("Couldn't read that file: " + err.message);
  }
});

/* ---------------------------------------------------------------- sessions */
function loadSessions() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
}

let sessions = loadSessions();
let activeId = sessions[0]?.id || null;

function saveSessions() {
  writeLS(STORAGE_KEY, JSON.stringify(sessions));
  scheduleSync();
}

function getActive() {
  return sessions.find((s) => s.id === activeId);
}

function createSession() {
  const existingEmpty = sessions.find((s) => s.messages.length === 0);
  if (existingEmpty) {
    activeId = existingEmpty.id;
    renderSessions();
    renderMessages();
    return;
  }
  const session = { id: crypto.randomUUID(), title: "New chat", messages: [], persona: "default" };
  sessions.unshift(session);
  activeId = session.id;
  saveSessions();
  renderSessions();
  renderMessages();
}

function messageText(m) {
  if (m.text != null) return m.text;
  if (typeof m.display === "string") return m.display.split("\n\n![")[0];
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.filter((p) => p.type === "text").map((p) => p.text).join(" ");
  return "";
}

function sessionMatches(s, q) {
  if (s.title.toLowerCase().includes(q)) return true;
  return s.messages.some((m) => {
    const t = m.role === "user" ? messageText(m) : typeof m.content === "string" && !m.content.startsWith("__PROFILE__") ? m.content : "";
    return t.toLowerCase().includes(q);
  });
}

function renderSessions() {
  sessionsEl.innerHTML = "";
  const q = searchQuery.trim().toLowerCase();
  const list = q ? sessions.filter((s) => sessionMatches(s, q)) : sessions;
  if (!list.length) {
    const none = document.createElement("div");
    none.className = "no-results";
    none.textContent = q ? "No chats found" : "No chats yet";
    sessionsEl.appendChild(none);
    return;
  }
  list.forEach((s) => {
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === activeId ? " active" : "");
    item.dataset.id = s.id;

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = s.title;
    label.title = "Double-click to rename";
    label.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      label.contentEditable = "true";
      label.focus();
      const range = document.createRange();
      range.selectNodeContents(label);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    label.addEventListener("blur", () => {
      label.contentEditable = "false";
      s.title = label.textContent.trim() || "Untitled";
      saveSessions();
      if (s.id === activeId) sessionTitleEl.textContent = s.title;
    });
    label.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); label.blur(); }
    });

    const del = document.createElement("span");
    del.className = "del";
    del.innerHTML = '<svg class="icon" style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      sessions = sessions.filter((x) => x.id !== s.id);
      if (activeId === s.id) activeId = sessions[0]?.id || null;
      if (!activeId) createSession();
      saveSessions();
      renderSessions();
      renderMessages();
    });

    item.addEventListener("click", () => {
      if (label.isContentEditable || s.id === activeId) return;
      activeId = s.id;
      sessionsEl.querySelectorAll(".session-item").forEach((el) => el.classList.toggle("active", el.dataset.id === activeId));
      renderMessages();
    });
    item.append(label, del);
    sessionsEl.appendChild(item);
  });
}

$("searchInput").addEventListener("input", (e) => {
  searchQuery = e.target.value;
  renderSessions();
});

/* ---------------------------------------------------------------- bubbles */
function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}

function makeAvatar(role) {
  const avatar = document.createElement("div");
  avatar.className = `avatar ${role}`;
  avatar.innerHTML = role === "assistant" ? BRAND_ICON : ICON.user;
  return avatar;
}

function profileCardHTML(profile) {
  const initials = profile.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const details = profile.details.map((d) => `<div>${d}</div>`).join("");
  const verified = svg('<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>', 'stroke-width="2.2"');
  return (
    `<div class="profile-card"><div class="profile-avatar">${initials}</div>` +
    `<div><div class="name-row"><span class="profile-name">${profile.name}</span>` +
    `<span class="verified-badge" title="Verified">${verified}</span></div>` +
    `<span class="profile-role">${profile.role}</span>` +
    `<div class="profile-details">${details}</div>` +
    (profile.bio ? `<div class="profile-bio">${profile.bio}</div>` : "") +
    `</div></div>`
  );
}

function profileCopyText(profile) {
  let text = `${profile.name} — ${profile.role}\n` + profile.details.join("\n");
  if (profile.bio) text += `\n\n${profile.bio}`;
  return text;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/* Paints an assistant bubble from a state object: {text, tools, sources, running, error} */
function paintAssistant(div, st) {
  div.innerHTML = "";
  if (st.tools && st.tools.length) {
    const list = document.createElement("div");
    list.className = "tool-list";
    st.tools.forEach((t) => {
      const chip = document.createElement("div");
      chip.className = "tool-chip";
      const lead = document.createElement("span");
      lead.style.display = "flex";
      if (t.state === "running") lead.innerHTML = '<span class="spinner"></span>';
      else lead.innerHTML = TOOL_ICONS[t.name] || ICON.globe;
      const text = document.createElement("span");
      text.className = "tool-text";
      text.textContent = t.label;
      chip.append(lead, text);
      if (t.summary && t.state !== "running") {
        const meta = document.createElement("span");
        meta.className = "tool-meta";
        meta.textContent = "· " + t.summary;
        chip.appendChild(meta);
      }
      list.appendChild(chip);
    });
    div.appendChild(list);
  }

  const body = document.createElement("div");
  body.className = "md";
  const text = st.text || "";
  if (text.startsWith("__PROFILE__")) {
    const profile = JSON.parse(text.slice("__PROFILE__".length));
    body.innerHTML = profileCardHTML(profile);
    div.dataset.raw = profileCopyText(profile);
  } else if (text) {
    body.innerHTML = renderMd(text, st.sources);
    div.dataset.raw = text;
  } else if (st.error) {
    body.innerHTML = `<span class="error-text">Something went wrong: ${st.error.replace(/</g, "&lt;")}</span>`;
  } else if (st.running) {
    body.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  }
  div.appendChild(body);

  (st.documents || []).forEach((d) => div.appendChild(docCard(d)));

  if (st.sources && st.sources.length) {
    const box = document.createElement("div");
    box.className = "sources";
    box.innerHTML = '<div class="sources-label">Sources</div>';
    const list = document.createElement("div");
    list.className = "source-list";
    const VISIBLE = 3;
    st.sources.forEach((s, i) => {
      const a = document.createElement("a");
      a.className = "source-row";
      a.id = `src-${i + 1}`;
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = s.url;
      a.hidden = i >= VISIBLE;
      const n = document.createElement("b");
      n.textContent = i + 1;
      const body = document.createElement("span");
      body.className = "src-body";
      const title = document.createElement("span");
      title.className = "src-title";
      title.textContent = s.title || hostOf(s.url);
      const host = document.createElement("span");
      host.className = "src-host";
      host.textContent = hostOf(s.url);
      body.append(title, host);
      a.append(n, body);
      list.appendChild(a);
    });
    box.appendChild(list);
    if (st.sources.length > VISIBLE) {
      const more = document.createElement("button");
      more.className = "source-more";
      const hiddenCount = st.sources.length - VISIBLE;
      more.textContent = `Show ${hiddenCount} more source${hiddenCount > 1 ? "s" : ""}`;
      more.addEventListener("click", () => {
        const expanded = more.dataset.open === "1";
        list.querySelectorAll(".source-row").forEach((row, i) => (row.hidden = expanded && i >= VISIBLE));
        more.dataset.open = expanded ? "0" : "1";
        more.textContent = expanded ? `Show ${hiddenCount} more source${hiddenCount > 1 ? "s" : ""}` : "Show fewer";
      });
      box.appendChild(more);
    }
    div.appendChild(box);
  }
  if (!st.running) highlightCode(div);
}

/* ---------------------------------------------------------------- generated documents */
const EYE_ICON = svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>');

function wordCount(t) {
  return t.trim().split(/\s+/).filter(Boolean).length;
}

function stripLeadingTitle(d) {
  const lines = d.markdown.trim().split("\n");
  const m = /^#\s+(.*)$/.exec(lines[0] || "");
  return m && m[1].trim().toLowerCase() === d.title.trim().toLowerCase() ? lines.slice(1).join("\n").trim() : d.markdown.trim();
}

function docMarkdownFile(d) {
  return `# ${d.title}\n\n${stripLeadingTitle(d)}\n`;
}

async function downloadDocx(d, btn) {
  const label = btn.querySelector("span");
  const original = label.textContent;
  label.textContent = "Preparing…";
  btn.disabled = true;
  try {
    const res = await fetch("/documents/docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: d.title, markdown: d.markdown }),
    });
    if (!res.ok) throw new Error("docx failed");
    downloadBlob(await res.blob(), `${slug(d.title)}.docx`);
  } catch {
    flashHint("Couldn't create the Word file. Try Markdown or PDF instead.");
  } finally {
    label.textContent = original;
    btn.disabled = false;
  }
}

function docBtn(iconHtml, label, onClick) {
  const b = document.createElement("button");
  b.className = "doc-btn";
  b.innerHTML = `${iconHtml}<span>${label}</span>`;
  b.addEventListener("click", () => onClick(b));
  return b;
}

function docCard(d) {
  const card = document.createElement("div");
  card.className = "doc-card";

  const head = document.createElement("div");
  head.className = "doc-head";
  const icon = document.createElement("div");
  icon.className = "doc-icon";
  icon.innerHTML = ICON.file;
  const info = document.createElement("div");
  info.className = "doc-info";
  const title = document.createElement("div");
  title.className = "doc-title";
  title.textContent = d.title;
  const meta = document.createElement("div");
  meta.className = "doc-meta";
  meta.textContent = `Document · ${wordCount(d.markdown).toLocaleString()} words`;
  info.append(title, meta);
  head.append(icon, info);

  const preview = document.createElement("div");
  preview.className = "doc-preview";
  preview.hidden = true;

  const actions = document.createElement("div");
  actions.className = "doc-actions";
  actions.append(
    docBtn(EYE_ICON, "Preview", (b) => {
      preview.hidden = !preview.hidden;
      if (!preview.hidden && !preview.innerHTML) {
        preview.innerHTML = renderMd(stripLeadingTitle(d));
        highlightCode(preview);
      }
      b.querySelector("span").textContent = preview.hidden ? "Preview" : "Hide";
    }),
    docBtn(ICON.download, "Word", (b) => downloadDocx(d, b)),
    docBtn(ICON.download, "PDF", () =>
      printHtml(d.title, `<div class="meta">Created ${new Date().toLocaleDateString()}</div>${renderMd(stripLeadingTitle(d))}`)
    ),
    docBtn(ICON.download, "Markdown", () =>
      downloadBlob(new Blob([docMarkdownFile(d)], { type: "text/markdown" }), `${slug(d.title)}.md`)
    )
  );

  card.append(head, actions, preview);
  return card;
}

function makeActionButton(iconHtml, label, onClick) {
  const b = document.createElement("button");
  b.innerHTML = `${iconHtml}<span>${label}</span>`;
  b.addEventListener("click", onClick);
  return b;
}

function makeCopyButton(getText) {
  const btn = makeActionButton(ICON.copy, "Copy", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.innerHTML = `${ICON.check}<span>Copied</span>`;
      setTimeout(() => (btn.innerHTML = `${ICON.copy}<span>Copy</span>`), 1200);
    } catch {}
  });
  return btn;
}

function statsLabel(st) {
  const parts = [];
  if (st.total_ms != null) parts.push(`${(st.total_ms / 1000).toFixed(1)}s`);
  if (st.total_tokens) parts.push(`${st.total_tokens.toLocaleString()} tokens`);
  if (st.tool_calls) parts.push(`${st.tool_calls} tool call${st.tool_calls > 1 ? "s" : ""}`);
  if (st.model) parts.push(st.model.split("/").pop());
  return parts.join(" · ");
}

function statsTooltip(st) {
  const lines = [];
  if (st.ttft_ms != null) lines.push(`First token: ${(st.ttft_ms / 1000).toFixed(2)}s`);
  if (st.prompt_tokens != null) lines.push(`Prompt: ${st.prompt_tokens} tokens`);
  if (st.completion_tokens != null) lines.push(`Reply: ${st.completion_tokens} tokens`);
  if (st.completion_tokens && st.total_ms) lines.push(`Speed: ~${Math.round((st.completion_tokens / st.total_ms) * 1000)} tokens/s`);
  return lines.join("\n");
}

let speakingBtn = null;
function toggleSpeak(btn, text) {
  const synth = window.speechSynthesis;
  const wasThis = speakingBtn === btn;
  synth.cancel();
  if (speakingBtn) {
    speakingBtn.classList.remove("on");
    speakingBtn.querySelector("span").textContent = "Listen";
    speakingBtn = null;
  }
  if (wasThis || !text.trim()) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = navigator.language || "en-US";
  const done = () => {
    if (speakingBtn === btn) {
      btn.classList.remove("on");
      btn.querySelector("span").textContent = "Listen";
      speakingBtn = null;
    }
  };
  u.onend = done;
  u.onerror = done;
  speakingBtn = btn;
  btn.classList.add("on");
  btn.querySelector("span").textContent = "Stop";
  synth.speak(u);
}

function buildActions(m, idx, bubble) {
  const actions = document.createElement("div");
  actions.className = "bubble-actions";
  actions.appendChild(makeCopyButton(() => bubble.dataset.raw ?? bubble.innerText));
  if (m.role === "user") {
    actions.appendChild(makeActionButton(ICON.edit, "Edit", () => startEdit(idx)));
  } else {
    if ("speechSynthesis" in window && !(m.content || "").startsWith("__PROFILE__")) {
      const listen = makeActionButton(ICON.speaker, "Listen", () => {
        const md = bubble.querySelector(".md");
        toggleSpeak(listen, (md ? md.innerText : bubble.innerText) || "");
      });
      actions.appendChild(listen);
    }
    const s = getActive();
    if (s && idx === s.messages.length - 1) actions.appendChild(makeActionButton(ICON.refresh, "Regenerate", regenerate));
    if (m.stats) {
      const stats = document.createElement("span");
      stats.className = "stats";
      stats.textContent = statsLabel(m.stats);
      stats.title = statsTooltip(m.stats);
      actions.appendChild(stats);
    }
  }
  return actions;
}

function addBubble(m, idx) {
  const row = document.createElement("div");
  row.className = `bubble-row ${m.role}`;
  row.dataset.idx = idx;
  row.appendChild(makeAvatar(m.role));

  const col = document.createElement("div");
  col.className = "bubble-col";
  const div = document.createElement("div");
  div.className = `bubble ${m.role}`;

  if (m.role === "assistant") {
    paintAssistant(div, {
      text: typeof m.content === "string" ? m.content : "",
      tools: m.tools,
      sources: m.sources,
      documents: m.documents,
    });
  } else {
    div.innerHTML = marked.parse(m.display || (typeof m.content === "string" ? m.content : "") || "");
    if (m.fileName) {
      const chip = document.createElement("div");
      chip.className = "bubble-file";
      const icon = document.createElement("span");
      icon.innerHTML = ICON.file;
      const name = document.createElement("span");
      name.textContent = m.fileName;
      chip.append(icon, name);
      div.appendChild(chip);
    }
    div.dataset.raw = messageText(m);
  }
  col.append(div, buildActions(m, idx, div));
  row.appendChild(col);
  messagesEl.appendChild(row);
  return div;
}

function renderMessages() {
  const session = getActive();
  messagesEl.innerHTML = "";
  sessionTitleEl.textContent = session ? session.title : "New chat";
  syncPersonaSelect();
  updateFiles();
  updateChatTokens();
  if (!session || session.messages.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.innerHTML = `<div class="empty-badge">${BRAND_ICON}</div><span>Ask me anything to get started.</span>`;
    messagesEl.appendChild(hint);
    return;
  }
  session.messages.forEach((m, i) => addBubble(m, i));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateChatTokens() {
  const el = $("chatTokens");
  const session = getActive();
  const total = session ? session.messages.reduce((n, m) => n + (m.stats?.total_tokens || 0), 0) : 0;
  el.hidden = total === 0;
  if (total) {
    el.textContent = `· ${total.toLocaleString()} tokens used`;
    el.title = "Total tokens used by replies in this chat";
  }
}

/* ---------------------------------------------------------------- edit / regenerate */
function startEdit(idx) {
  if (isGenerating) return;
  const session = getActive();
  const m = session.messages[idx];
  const row = messagesEl.querySelector(`.bubble-row[data-idx="${idx}"]`);
  if (!row) return;
  const col = row.querySelector(".bubble-col");
  col.innerHTML = "";
  const box = document.createElement("div");
  box.className = "edit-box";
  const ta = document.createElement("textarea");
  ta.value = messageText(m);
  const actions = document.createElement("div");
  actions.className = "edit-actions";
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", renderMessages);
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = "Save & resend";
  save.addEventListener("click", () => applyEdit(idx, ta.value.trim()));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); }
    if (e.key === "Escape") { e.stopPropagation(); renderMessages(); }
  });
  actions.append(cancel, save);
  box.append(ta, actions);
  col.appendChild(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function replacePrefix(str, oldPrefix, newPrefix) {
  return typeof str === "string" && str.startsWith(oldPrefix) ? newPrefix + str.slice(oldPrefix.length) : newPrefix;
}

function applyEdit(idx, newText) {
  const session = getActive();
  const m = session.messages[idx];
  if (!newText) return;
  const old = messageText(m);
  if (typeof m.content === "string") m.content = replacePrefix(m.content, old, newText);
  else if (Array.isArray(m.content)) m.content = m.content.map((p) => (p.type === "text" ? { ...p, text: newText } : p));
  if (typeof m.display === "string") m.display = replacePrefix(m.display, old, newText);
  m.text = newText;
  session.messages.length = idx + 1;
  if (idx === 0) session.title = newText.slice(0, 40);
  saveSessions();
  renderSessions();
  renderMessages();
  generateReply(session);
}

function regenerate() {
  if (isGenerating) return;
  const session = getActive();
  while (session.messages.length && session.messages[session.messages.length - 1].role === "assistant") session.messages.pop();
  if (!session.messages.length) return;
  saveSessions();
  renderMessages();
  generateReply(session);
}

/* ---------------------------------------------------------------- input + sending */
function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}
inputEl.addEventListener("input", autoResize);

function setGenerating(state) {
  isGenerating = state;
  sendBtn.innerHTML = state ? ICON.stopBig : ICON.send;
  sendBtn.title = state ? "Stop" : "Send";
  sendBtn.classList.toggle("stop", state);
  sendBtn.classList.toggle("send", !state);
  if (!state) sendBtn.disabled = false;
}

async function send() {
  if (isGenerating) {
    currentAbort?.abort();
    return;
  }
  if (listening) recog?.stop();

  const text = inputEl.value.trim();
  if (!text && !pendingAttachment) return;
  inputEl.value = "";
  autoResize();

  let session = getActive();
  if (!session) {
    createSession();
    session = getActive();
  }

  const displayText = text || `Explain this file: ${pendingAttachment.name}`;
  let content = displayText;
  if (pendingAttachment?.type === "image") {
    content = [
      { type: "text", text: displayText },
      { type: "image_url", image_url: { url: pendingAttachment.dataUrl } },
    ];
  } else if (pendingAttachment) {
    content = `${displayText}\n\n[Attached file: ${pendingAttachment.name}]\n` + "```\n" + pendingAttachment.content + "\n```";
    if (pendingAttachment.truncated) content += "\n\n(Note: file was truncated to fit the context window.)";
  }

  if (session.messages.length === 0) session.title = displayText.slice(0, 40);

  const display =
    pendingAttachment?.type === "image" ? `${displayText}\n\n![${pendingAttachment.name}](${pendingAttachment.dataUrl})` : displayText;
  const fileName = pendingAttachment && pendingAttachment.type !== "image" ? pendingAttachment.name : null;

  session.messages.push({ role: "user", content, display, fileName, text: displayText });
  pendingAttachment = null;
  renderAttachmentChip();
  saveSessions();
  renderMessages();
  renderSessions();
  await generateReply(session);
}

async function generateReply(session) {
  const row = document.createElement("div");
  row.className = "bubble-row assistant";
  row.appendChild(makeAvatar("assistant"));
  const col = document.createElement("div");
  col.className = "bubble-col";
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";
  col.appendChild(bubble);
  row.appendChild(col);
  messagesEl.appendChild(row);

  const st = { text: "", tools: [], sources: [], documents: [], running: true, error: null };
  paintAssistant(bubble, st);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const t0 = performance.now();
  let ttft = null;
  let serverStats = null;
  setGenerating(true);
  currentAbort = new AbortController();
  const paint = () => {
    paintAssistant(bubble, st);
    if (isNearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: session.messages.map((m) => ({ role: m.role, content: m.content })),
        system_prompt: getStoredSystemPrompt(),
        persona: session.persona || "default",
        tools_enabled: toolsEnabled,
      }),
      signal: currentAbort.signal,
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop();
      for (const chunk of chunks) {
        if (!chunk.startsWith("data: ")) continue;
        const data = chunk.slice(6);
        if (data === "[DONE]") continue;
        const ev = JSON.parse(data);
        if (ev.delta != null) {
          if (ttft == null) ttft = performance.now() - t0;
          st.text += ev.delta;
        } else if (ev.profile) {
          st.text = "__PROFILE__" + JSON.stringify(ev.profile);
        } else if (ev.tool_start) {
          st.tools.push({ ...ev.tool_start, state: "running" });
        } else if (ev.tool_result) {
          const t = st.tools.find((x) => x.id === ev.tool_result.id);
          if (t) { t.state = "done"; t.summary = ev.tool_result.summary; }
        } else if (ev.document) {
          st.documents.push(ev.document);
        } else if (ev.sources) {
          st.sources.push(...ev.sources);
        } else if (ev.stats) {
          serverStats = ev.stats;
        } else if (ev.error) {
          st.error = ev.error;
        }
        paint();
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") st.error = err.message;
  }

  st.running = false;
  st.tools.forEach((t) => { if (t.state === "running") t.state = "done"; });
  const hasContent = !!(st.text || st.documents.length);
  if (hasContent) {
    const msg = { role: "assistant", content: st.text };
    if (st.tools.length) msg.tools = st.tools.map(({ id, name, label, summary }) => ({ id, name, label, summary, state: "done" }));
    if (st.sources.length) msg.sources = st.sources;
    if (st.documents.length) msg.documents = st.documents;
    if (serverStats) msg.stats = { ...serverStats, total_ms: Math.round(performance.now() - t0), ttft_ms: ttft != null ? Math.round(ttft) : null };
    session.messages.push(msg);
    saveSessions();
    renderSessions();
  }
  setGenerating(false);
  currentAbort = null;

  if (hasContent && activeId === session.id) {
    renderMessages();
  } else if (!hasContent && st.error) {
    paintAssistant(bubble, st);
    const retry = document.createElement("button");
    retry.className = "retry-btn";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => {
      row.remove();
      generateReply(session);
    });
    bubble.appendChild(retry);
  } else if (!hasContent) {
    row.remove(); // stopped before anything useful arrived
  }
  inputEl.focus();
}

$("newChat").addEventListener("click", createSession);
sendBtn.addEventListener("click", send);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

/* ---------------------------------------------------------------- tools toggle */
const toolsBtn = $("toolsBtn");
function paintToolsBtn() {
  toolsBtn.classList.toggle("on", toolsEnabled);
  toolsBtn.title = toolsEnabled ? "Web search & tools: on (click to turn off)" : "Web search & tools: off (click to turn on)";
}
toolsBtn.addEventListener("click", () => {
  toolsEnabled = !toolsEnabled;
  writeLS(TOOLS_KEY, toolsEnabled ? "on" : "off");
  paintToolsBtn();
  flashHint(toolsEnabled ? "Web search, weather and calculator are on" : "Tools are off, the model will answer from its own knowledge");
});
paintToolsBtn();

let hintTimer = null;
const hintRow = $("hintRow");
const DEFAULT_HINT = hintRow.textContent;
function flashHint(msg) {
  hintRow.textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (hintRow.textContent = DEFAULT_HINT), 3500);
}

/* ---------------------------------------------------------------- voice input */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $("micBtn");
let recog = null;
let listening = false;
if (SpeechRec) {
  micBtn.hidden = false;
  micBtn.addEventListener("click", () => {
    if (listening) { recog.stop(); return; }
    recog = new SpeechRec();
    recog.lang = navigator.language || "en-US";
    recog.interimResults = true;
    recog.continuous = true;
    const base = inputEl.value ? inputEl.value.replace(/\s*$/, " ") : "";
    recog.onstart = () => {
      listening = true;
      micBtn.classList.add("listening");
      micBtn.title = "Stop listening";
    };
    recog.onresult = (e) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      inputEl.value = base + transcript;
      autoResize();
    };
    recog.onerror = (e) => {
      const msg = {
        "not-allowed": "Microphone permission was denied. Allow it in your browser's site settings.",
        "no-speech": "Didn't catch anything. Try again.",
        "audio-capture": "No microphone found.",
        network: "Speech recognition needs an internet connection.",
      }[e.error];
      flashHint(msg || `Voice input error: ${e.error}`);
    };
    recog.onend = () => {
      listening = false;
      micBtn.classList.remove("listening");
      micBtn.title = "Voice input";
      inputEl.focus();
    };
    try { recog.start(); } catch {}
  });
}

/* ---------------------------------------------------------------- personas */
const personaSelect = $("personaSelect");
async function loadPersonas() {
  try {
    personas = await (await fetch("/personas")).json();
  } catch {
    personas = [{ id: "default", name: "Default", description: "" }];
  }
  personaSelect.innerHTML = "";
  personas.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    o.title = p.description;
    personaSelect.appendChild(o);
  });
  syncPersonaSelect();
}
function syncPersonaSelect() {
  const s = getActive();
  personaSelect.value = (s && s.persona) || "default";
  const p = personas.find((x) => x.id === personaSelect.value);
  personaSelect.parentElement.title = p ? `Persona: ${p.name}${p.description ? " - " + p.description : ""}` : "Persona";
}
personaSelect.addEventListener("change", () => {
  const s = getActive();
  if (!s) return;
  s.persona = personaSelect.value;
  saveSessions();
  syncPersonaSelect();
  flashHint(`Persona set to ${personaSelect.selectedOptions[0]?.textContent}. It applies to your next message.`);
});

/* ---------------------------------------------------------------- files panel */
const filesPanel = $("filesPanel");
const filesBody = $("filesBody");
const filesBtn = $("filesBtn");
const filesCountEl = $("filesCount");
let filesState = { uploaded: [], generated: [] };

const LANG_EXT = {
  python: "py", py: "py", javascript: "js", js: "js", typescript: "ts", ts: "ts", jsx: "jsx", tsx: "tsx",
  html: "html", css: "css", json: "json", sql: "sql", bash: "sh", sh: "sh", shell: "sh", java: "java",
  c: "c", cpp: "cpp", csharp: "cs", cs: "cs", yaml: "yaml", yml: "yml", xml: "xml", markdown: "md",
  md: "md", go: "go", rust: "rs", php: "php", ruby: "rb", text: "txt", txt: "txt",
};

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function collectFiles(session) {
  const uploaded = [];
  const generated = [];
  if (!session) return { uploaded, generated };
  let snippetNo = 0;
  session.messages.forEach((m) => {
    if (m.role === "user") {
      if (Array.isArray(m.content)) {
        const img = m.content.find((p) => p.type === "image_url");
        if (img) {
          const alt = /!\[([^\]]*)\]/.exec(m.display || "");
          const url = img.image_url.url;
          uploaded.push({ kind: "image", name: (alt && alt[1]) || "image", dataUrl: url, size: Math.round(url.length * 0.75) });
        }
      } else if (typeof m.content === "string") {
        const mt = /\[Attached file: (.+?)\]\n```\n([\s\S]*)\n```/.exec(m.content);
        if (mt) uploaded.push({ kind: "text", name: mt[1], text: mt[2], size: new Blob([mt[2]]).size });
      }
    } else if (m.role === "assistant" && typeof m.content === "string" && !m.content.startsWith("__PROFILE__")) {
      const re = /```([\w+-]*)\n([\s\S]*?)```/g;
      let b;
      while ((b = re.exec(m.content))) {
        const code = b[2].replace(/\n$/, "");
        if (code.trim().length < 20) continue;
        snippetNo++;
        const lang = b[1].toLowerCase();
        generated.push({ kind: "code", name: `snippet-${snippetNo}.${LANG_EXT[lang] || lang || "txt"}`, text: code, size: new Blob([code]).size });
      }
      (m.documents || []).forEach((d) => {
        const text = docMarkdownFile(d);
        generated.push({ kind: "doc", name: `${slug(d.title)}.md`, text, size: new Blob([text]).size });
      });
    }
  });
  return { uploaded, generated };
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadFile(f) {
  if (f.kind === "image") {
    const a = document.createElement("a");
    a.href = f.dataUrl;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    downloadBlob(new Blob([f.text], { type: "text/plain" }), /\.pdf$/i.test(f.name) ? f.name.replace(/\.pdf$/i, "") + ".txt" : f.name);
  }
}

function fileCard(f) {
  const card = document.createElement("div");
  card.className = "file-card";
  const row = document.createElement("div");
  row.className = "file-row";
  const icon = document.createElement("div");
  icon.className = "file-icon";
  icon.innerHTML = f.kind === "image" ? ICON.image : f.kind === "code" ? ICON.code : ICON.file;
  const info = document.createElement("div");
  info.className = "file-info";
  const name = document.createElement("div");
  name.className = "file-name";
  name.textContent = f.name;
  name.title = f.name;
  const meta = document.createElement("div");
  meta.className = "file-meta";
  const isPdf = /\.pdf$/i.test(f.name);
  meta.textContent = `${f.kind === "image" ? "Image" : isPdf ? "PDF · extracted text" : f.kind === "code" ? "Generated code" : f.kind === "doc" ? "Generated document" : "Text file"} · ${fmtSize(f.size)}`;
  info.append(name, meta);
  const dl = document.createElement("button");
  dl.className = "file-dl";
  dl.title = "Download";
  dl.innerHTML = ICON.download;
  dl.addEventListener("click", (e) => { e.stopPropagation(); downloadFile(f); });
  row.append(icon, info, dl);
  card.appendChild(row);

  let preview = null;
  row.addEventListener("click", () => {
    if (preview) { preview.remove(); preview = null; return; }
    preview = document.createElement("div");
    preview.className = "file-preview";
    if (f.kind === "image") {
      const img = document.createElement("img");
      img.src = f.dataUrl;
      img.alt = f.name;
      preview.appendChild(img);
    } else {
      const pre = document.createElement("pre");
      pre.textContent = f.text.length > 4000 ? f.text.slice(0, 4000) + "\n… (preview truncated)" : f.text;
      preview.appendChild(pre);
    }
    card.appendChild(preview);
  });
  return card;
}

function renderFilesPanel() {
  filesBody.innerHTML = "";
  const { uploaded, generated } = filesState;
  if (!uploaded.length && !generated.length) {
    const empty = document.createElement("div");
    empty.className = "files-empty";
    empty.textContent = "No files yet. Attach a file with the paperclip and it will show up here.";
    filesBody.appendChild(empty);
    return;
  }
  const section = (label, list) => {
    if (!list.length) return;
    const h = document.createElement("div");
    h.className = "files-section-label";
    h.textContent = `${label} (${list.length})`;
    filesBody.appendChild(h);
    list.forEach((f) => filesBody.appendChild(fileCard(f)));
  };
  section("Uploaded", uploaded);
  section("Generated", generated);
}

function updateFiles() {
  filesState = collectFiles(getActive());
  const total = filesState.uploaded.length + filesState.generated.length;
  filesCountEl.textContent = total;
  filesCountEl.hidden = total === 0;
  if (filesPanel.classList.contains("open")) renderFilesPanel();
}

function setFilesPanel(open) {
  filesPanel.classList.toggle("open", open);
  filesPanel.setAttribute("aria-hidden", String(!open));
  filesBtn.classList.toggle("active", open);
  if (open) renderFilesPanel();
}
filesBtn.addEventListener("click", () => setFilesPanel(!filesPanel.classList.contains("open")));
$("filesClose").addEventListener("click", () => setFilesPanel(false));

/* ---------------------------------------------------------------- export */
const exportMenu = $("exportMenu");
$("exportBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  exportMenu.hidden = !exportMenu.hidden;
});
document.addEventListener("click", () => (exportMenu.hidden = true));

function slug(title) {
  return (title || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chat";
}

function assistantPlain(m) {
  if ((m.content || "").startsWith("__PROFILE__")) return profileCopyText(JSON.parse(m.content.slice("__PROFILE__".length)));
  return m.content || "";
}

function exportMarkdown(session) {
  const persona = personas.find((p) => p.id === (session.persona || "default"));
  let md = `# ${session.title}\n\n*Exported ${new Date().toLocaleString()}${persona && persona.id !== "default" ? ` · Persona: ${persona.name}` : ""}*\n\n`;
  session.messages.forEach((m) => {
    if (m.role === "user") {
      md += `### You\n\n${messageText(m)}\n\n`;
      if (m.fileName) md += `> Attached file: ${m.fileName}\n\n`;
      else if (Array.isArray(m.content)) {
        const alt = /!\[([^\]]*)\]/.exec(m.display || "");
        md += `> Attached image: ${(alt && alt[1]) || "image"}\n\n`;
      }
    } else {
      md += `### Assistant\n\n${assistantPlain(m)}\n\n`;
      (m.documents || []).forEach((d) => (md += `> Document created: ${d.title}\n\n`));
      if (m.sources?.length) md += "**Sources**\n\n" + m.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n") + "\n\n";
    }
  });
  downloadBlob(new Blob([md], { type: "text/markdown" }), `${slug(session.title)}.md`);
}

function exportPdf(session) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = session.messages
    .map((m) => {
      if (m.role === "user") {
        const img = Array.isArray(m.content) ? m.content.find((p) => p.type === "image_url") : null;
        return (
          `<div class="msg"><div class="who">You</div><div>${marked.parse(messageText(m))}</div>` +
          (m.fileName ? `<div class="file">Attached file: ${esc(m.fileName)}</div>` : "") +
          (img ? `<img src="${img.image_url.url}" />` : "") +
          `</div>`
        );
      }
      const sources = m.sources?.length
        ? `<div class="src"><b>Sources</b><ol>${m.sources.map((s) => `<li><a href="${s.url}">${esc(s.title)}</a></li>`).join("")}</ol></div>`
        : "";
      return `<div class="msg"><div class="who">Assistant</div><div>${renderMd(assistantPlain(m), m.sources)}</div>${sources}</div>`;
    })
    .join("");
  printHtml(session.title, `<div class="meta">Exported ${new Date().toLocaleString()}</div>${body}`);
}

const PRINT_CSS =
  `body{font-family:Inter,Segoe UI,Arial,sans-serif;color:#14141c;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.55;font-size:14px}` +
  `h1{font-size:1.5rem;margin:0 0 .3rem}h2{font-size:1.15rem;margin:1.4rem 0 .4rem}h3{font-size:1rem}.meta{color:#6b6b7a;font-size:.8rem;margin-bottom:1.5rem}` +
  `.msg{margin:0 0 1.1rem;page-break-inside:avoid}.who{font-weight:700;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:#6d5ef0;margin-bottom:.2rem}` +
  `pre{background:#f1f1f6;padding:.7rem;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-size:.8rem}code{font-family:Consolas,monospace}` +
  `table{border-collapse:collapse;width:100%;margin:.6rem 0}td,th{border:1px solid #ccd;padding:.35rem .6rem;text-align:left;vertical-align:top}th{background:#eceff8}` +
  `img{max-width:320px;border-radius:8px;display:block;margin-top:.4rem}.file{color:#6b6b7a;font-size:.8rem}.src{font-size:.8rem;color:#444}a{color:#3b4fc4}` +
  `blockquote{border-left:3px solid #c9c9d6;margin:.6rem 0;padding:.1rem .9rem;color:#555}`;

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function printHtml(title, innerHtml) {
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>${PRINT_CSS}</style></head>` +
    `<body><h1>${escHtml(title)}</h1>${innerHtml}</body></html>`;
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(frame);
  frame.onload = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 2000);
  };
  frame.srcdoc = html;
}

exportMenu.addEventListener("click", (e) => {
  const kind = e.target.dataset.export;
  const session = getActive();
  if (!kind || !session || !session.messages.length) {
    if (kind) flashHint("Nothing to export yet. Send a message first.");
    return;
  }
  exportMenu.hidden = true;
  if (kind === "md") exportMarkdown(session);
  else exportPdf(session);
});

/* ---------------------------------------------------------------- accounts & sync */
let auth = (() => { try { return JSON.parse(readLS(AUTH_KEY)); } catch { return null; } })();
let syncStatus = "idle"; // idle | syncing | ok | err
let syncTimer = null;
const synced = new Map(); // chat id -> JSON string last known on the server

function authFetch(path, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}), Authorization: `Bearer ${auth?.token}` },
  });
}

function setSyncStatus(s) {
  syncStatus = s;
  renderAccount();
}

function scheduleSync() {
  if (!auth) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 800);
}

async function syncNow() {
  if (!auth) return;
  try {
    const current = new Map(sessions.filter((s) => s.messages.length).map((s) => [s.id, JSON.stringify(s)]));
    const jobs = [];
    for (const [id, json] of current) {
      if (synced.get(id) !== json) {
        jobs.push(
          authFetch(`/chats/${id}`, { method: "PUT", body: JSON.stringify({ data: JSON.parse(json) }) }).then((r) => {
            if (r.status === 401) throw new Error("auth");
            if (!r.ok) throw new Error("sync");
            synced.set(id, json);
          })
        );
      }
    }
    for (const id of [...synced.keys()]) {
      if (!current.has(id)) {
        jobs.push(authFetch(`/chats/${id}`, { method: "DELETE" }).then(() => synced.delete(id)));
      }
    }
    if (!jobs.length) return;
    setSyncStatus("syncing");
    await Promise.all(jobs);
    setSyncStatus("ok");
  } catch (e) {
    if (e.message === "auth") signOutLocal();
    else setSyncStatus("err");
  }
}

async function pullAndMerge() {
  if (!auth) return;
  setSyncStatus("syncing");
  try {
    const res = await authFetch("/chats");
    if (res.status === 401) { signOutLocal(); return; }
    if (!res.ok) throw new Error("pull");
    const server = await res.json();
    const byId = new Map(server.map((s) => [s.id, s]));
    const wasOnEmptyChat = getActive()?.messages.length === 0;
    const merged = [];
    for (const local of sessions) {
      const remote = byId.get(local.id);
      if (!local.messages.length) continue;
      if (!remote) merged.push(local);
      else if (local.messages.length > remote.messages.length) { merged.push(local); byId.delete(local.id); }
    }
    synced.clear();
    for (const s of server) {
      if (byId.has(s.id)) { merged.push(s); synced.set(s.id, JSON.stringify(s)); }
    }
    const fresh = { id: crypto.randomUUID(), title: "New chat", messages: [], persona: "default" };
    sessions = [fresh, ...merged];
    if (wasOnEmptyChat || !sessions.some((s) => s.id === activeId)) activeId = fresh.id;
    writeLS(STORAGE_KEY, JSON.stringify(sessions));
    renderSessions();
    if (!isGenerating) renderMessages();
    setSyncStatus("ok");
    scheduleSync();
  } catch {
    setSyncStatus("err");
  }
}

function signOutLocal() {
  auth = null;
  try { localStorage.removeItem(AUTH_KEY); } catch {}
  synced.clear();
  syncStatus = "idle";
  renderAccount();
}

async function signOut() {
  if (auth) {
    clearTimeout(syncTimer);
    await syncNow();
    try { await authFetch("/auth/logout", { method: "POST" }); } catch {}
  }
  signOutLocal();
  sessions = [];
  activeId = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  createSession();
}

function renderAccount() {
  const row = $("accountRow");
  row.innerHTML = "";
  const btn = document.createElement("div");
  btn.className = "account-btn";
  const avatar = document.createElement("div");
  const text = document.createElement("div");
  text.className = "account-text";
  const name = document.createElement("div");
  name.className = "account-name";
  const sub = document.createElement("div");
  sub.className = "account-sub";
  if (!auth) {
    avatar.className = "account-avatar guest";
    avatar.innerHTML = ICON.user;
    name.textContent = "Guest";
    sub.textContent = "Chats stay on this device";
    btn.style.cursor = "pointer";
    btn.addEventListener("click", () => openAuth("login"));
    const go = document.createElement("span");
    go.className = "account-sub";
    go.style.color = "var(--accent-2)";
    go.textContent = "Sign in";
    text.append(name, sub);
    btn.append(avatar, text, go);
  } else {
    avatar.className = "account-avatar";
    avatar.textContent = auth.username[0].toUpperCase();
    name.textContent = auth.username;
    const label = { idle: "Signed in", syncing: "Syncing…", ok: "Synced to your account", err: "Sync failed, will retry" }[syncStatus];
    sub.textContent = label;
    sub.classList.toggle("ok", syncStatus === "ok");
    sub.classList.toggle("err", syncStatus === "err");
    const out = document.createElement("button");
    out.className = "file-dl";
    out.title = "Sign out";
    out.innerHTML = svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>');
    out.addEventListener("click", signOut);
    text.append(name, sub);
    btn.append(avatar, text, out);
  }
  row.appendChild(btn);
}

const authModal = $("authModal");
let authMode = "login";
function openAuth(mode) {
  authMode = mode;
  $("authTitle").textContent = mode === "login" ? "Sign in" : "Create account";
  $("authSubmit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("authDesc").textContent =
    mode === "login"
      ? "Sign in to load your saved chats on this device. Chats you made as a guest will be added to your account."
      : "Create an account to keep your chats on the server and open them from any device. Chats you made as a guest will be added to it.";
  $("authSwitch").textContent = mode === "login" ? "New here? Create an account" : "Already have an account? Sign in";
  $("authPass").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("authError").hidden = true;
  authModal.hidden = false;
  $("authUser").focus();
}
$("authSwitch").addEventListener("click", () => openAuth(authMode === "login" ? "register" : "login"));
$("authCancel").addEventListener("click", () => (authModal.hidden = true));
authModal.addEventListener("click", (e) => { if (e.target === authModal) authModal.hidden = true; });
$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("authError");
  err.hidden = true;
  const submit = $("authSubmit");
  submit.disabled = true;
  try {
    const res = await fetch(`/auth/${authMode === "login" ? "login" : "register"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("authUser").value.trim(), password: $("authPass").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Something went wrong. Check your details.");
    auth = { token: data.token, username: data.username };
    writeLS(AUTH_KEY, JSON.stringify(auth));
    authModal.hidden = true;
    $("authPass").value = "";
    renderAccount();
    await pullAndMerge();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

/* ---------------------------------------------------------------- theme + settings */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  writeLS(THEME_KEY, theme);
}
$("themeToggle").addEventListener("click", () => {
  applyTheme((document.documentElement.getAttribute("data-theme") || "dark") === "dark" ? "light" : "dark");
});
applyTheme(readLS(THEME_KEY) || "dark");

const settingsModal = $("settingsModal");
const systemPromptInput = $("systemPromptInput");
let defaultSystemPrompt = "";

function getStoredSystemPrompt() {
  return readLS(SYSTEM_PROMPT_KEY) || "";
}
function setStoredSystemPrompt(value) {
  try {
    if (value) localStorage.setItem(SYSTEM_PROMPT_KEY, value);
    else localStorage.removeItem(SYSTEM_PROMPT_KEY);
  } catch {}
}
async function ensureDefaultPrompt() {
  if (defaultSystemPrompt) return defaultSystemPrompt;
  try {
    defaultSystemPrompt = (await (await fetch("/settings/default-system-prompt")).json()).system_prompt;
  } catch {
    defaultSystemPrompt = "";
  }
  return defaultSystemPrompt;
}
$("openSettings").addEventListener("click", async () => {
  await ensureDefaultPrompt();
  systemPromptInput.value = getStoredSystemPrompt() || defaultSystemPrompt;
  settingsModal.hidden = false;
  systemPromptInput.focus();
});
$("cancelSettings").addEventListener("click", () => (settingsModal.hidden = true));
$("savePrompt").addEventListener("click", () => {
  const value = systemPromptInput.value.trim();
  setStoredSystemPrompt(value === defaultSystemPrompt ? "" : value);
  settingsModal.hidden = true;
});
$("resetPrompt").addEventListener("click", async () => {
  await ensureDefaultPrompt();
  systemPromptInput.value = defaultSystemPrompt;
});
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.hidden = true; });

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  setFilesPanel(false);
  exportMenu.hidden = true;
  settingsModal.hidden = true;
  authModal.hidden = true;
});

/* ---------------------------------------------------------------- start */
renderAccount();
loadPersonas();
if (sessions.length === 0) createSession();
else {
  renderSessions();
  renderMessages();
}
if (auth) pullAndMerge();
