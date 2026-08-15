import PostalMime from "postal-mime";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      await cleanupExpired(env.DB);
      return await handleApi(request, env, url);
    } catch (error) {
      console.error("API error:", error);
      return json({ error: "Internal server error" }, 500);
    }
  },

  async email(message, env) {
    try {
      const maxBytes = Number(env.MAX_EMAIL_BYTES || 10 * 1024 * 1024);
      if (message.rawSize > maxBytes) {
        message.setReject("Message too large");
        return;
      }

      await cleanupExpired(env.DB);

      const recipient = normalizeAddress(message.to);
      const mailbox = await env.DB
        .prepare(
          `SELECT id, address
           FROM mailboxes
           WHERE address = ?1 COLLATE NOCASE
             AND expires_at > ?2
           LIMIT 1`
        )
        .bind(recipient, nowSeconds())
        .first();

      if (!mailbox) {
        message.setReject("Mailbox is not active");
        return;
      }

      const parsed = await PostalMime.parse(message.raw);
      const subject = cleanString(parsed.subject || message.headers.get("subject") || "", 500);
      const textBody = cleanString(parsed.text || htmlToText(parsed.html || ""), 200000);
      const htmlBody = cleanString(parsed.html || "", 300000);
      const sender = cleanString(
        parsed.from?.address || parsed.from?.name || message.from || "unknown",
        500
      );

      const codes = extractVerificationCodes(`${subject}\n${textBody}`);

      await env.DB
        .prepare(
          `INSERT INTO messages
           (id, mailbox_id, sender, recipient, subject, text_body, html_body,
            codes_json, received_at, raw_size)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
        )
        .bind(
          crypto.randomUUID(),
          mailbox.id,
          sender,
          recipient,
          subject,
          textBody,
          htmlBody,
          JSON.stringify(codes),
          nowSeconds(),
          message.rawSize || 0
        )
        .run();
    } catch (error) {
      console.error("Email processing failed:", error);
      message.setReject("Temporary inbox processing error");
    }
  }
};

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/config" && method === "GET") {
    return json({
      domains: getDomains(env),
      mailboxTtlHours: getTtlHours(env)
    });
  }

  if (path === "/api/mailboxes" && method === "POST") {
    return createMailbox(request, env);
  }

  const listMatch = path.match(/^\/api\/mailboxes\/([a-zA-Z0-9-]+)\/messages$/);
  if (listMatch && method === "GET") {
    return listMessages(request, env, listMatch[1]);
  }

  const mailboxDeleteMatch = path.match(/^\/api\/mailboxes\/([a-zA-Z0-9-]+)$/);
  if (mailboxDeleteMatch && method === "DELETE") {
    return deleteMailbox(request, env, mailboxDeleteMatch[1]);
  }

  const messageMatch = path.match(/^\/api\/messages\/([a-zA-Z0-9-]+)$/);
  if (messageMatch && method === "GET") {
    return getMessage(request, env, messageMatch[1]);
  }

  return json({ error: "Not found" }, 404);
}

async function createMailbox(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const localPart = String(body?.name || "").trim().toLowerCase();
  const domain = String(body?.domain || "").trim().toLowerCase();
  const domains = getDomains(env);

  if (!/^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/.test(localPart)) {
    return json({
      error: "Name must be 1-32 characters using letters, numbers, dots, dashes or underscores."
    }, 400);
  }

  if (!domains.includes(domain)) {
    return json({ error: "That domain is not enabled." }, 400);
  }

  const address = `${localPart}@${domain}`;
  const id = crypto.randomUUID();
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const createdAt = nowSeconds();
  const expiresAt = createdAt + getTtlHours(env) * 3600;

  try {
    await env.DB
      .prepare(
        `INSERT INTO mailboxes
         (id, address, local_part, domain, token_hash, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(id, address, localPart, domain, tokenHash, createdAt, expiresAt)
      .run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      return json({
        error: "This address is already active. Choose another name."
      }, 409);
    }
    throw error;
  }

  return json({
    id,
    address,
    token,
    createdAt,
    expiresAt
  }, 201);
}

async function listMessages(request, env, mailboxId) {
  const auth = await authorizeMailbox(request, env.DB, mailboxId);
  if (!auth.ok) return auth.response;

  const result = await env.DB
    .prepare(
      `SELECT id, sender, subject, codes_json, received_at, raw_size
       FROM messages
       WHERE mailbox_id = ?1
       ORDER BY received_at DESC
       LIMIT 100`
    )
    .bind(mailboxId)
    .all();

  return json({
    mailbox: {
      id: auth.mailbox.id,
      address: auth.mailbox.address,
      expiresAt: auth.mailbox.expires_at
    },
    messages: (result.results || []).map(row => ({
      id: row.id,
      sender: row.sender,
      subject: row.subject,
      codes: safeJsonArray(row.codes_json),
      receivedAt: row.received_at,
      rawSize: row.raw_size
    }))
  });
}

async function getMessage(request, env, messageId) {
  const bearer = getBearer(request);
  if (!bearer) {
    return json({ error: "Missing inbox token" }, 401);
  }

  const row = await env.DB
    .prepare(
      `SELECT
         m.id, m.sender, m.recipient, m.subject, m.text_body, m.html_body,
         m.codes_json, m.received_at, m.raw_size,
         b.id AS mailbox_id, b.address, b.token_hash, b.expires_at
       FROM messages m
       JOIN mailboxes b ON b.id = m.mailbox_id
       WHERE m.id = ?1
       LIMIT 1`
    )
    .bind(messageId)
    .first();

  if (!row || row.expires_at <= nowSeconds()) {
    return json({ error: "Message not found" }, 404);
  }

  const hash = await sha256(bearer);
  if (!timingSafeEqualString(hash, row.token_hash)) {
    return json({ error: "Invalid inbox token" }, 403);
  }

  return json({
    id: row.id,
    sender: row.sender,
    recipient: row.recipient,
    subject: row.subject,
    text: row.text_body,
    html: row.html_body,
    codes: safeJsonArray(row.codes_json),
    receivedAt: row.received_at,
    rawSize: row.raw_size
  });
}

async function deleteMailbox(request, env, mailboxId) {
  const auth = await authorizeMailbox(request, env.DB, mailboxId);
  if (!auth.ok) return auth.response;

  await env.DB.prepare("DELETE FROM messages WHERE mailbox_id = ?1").bind(mailboxId).run();
  await env.DB.prepare("DELETE FROM mailboxes WHERE id = ?1").bind(mailboxId).run();

  return json({ ok: true });
}

async function authorizeMailbox(request, db, mailboxId) {
  const bearer = getBearer(request);
  if (!bearer) {
    return { ok: false, response: json({ error: "Missing inbox token" }, 401) };
  }

  const mailbox = await db
    .prepare(
      `SELECT id, address, token_hash, expires_at
       FROM mailboxes
       WHERE id = ?1
       LIMIT 1`
    )
    .bind(mailboxId)
    .first();

  if (!mailbox || mailbox.expires_at <= nowSeconds()) {
    return { ok: false, response: json({ error: "Inbox not found or expired" }, 404) };
  }

  const hash = await sha256(bearer);
  if (!timingSafeEqualString(hash, mailbox.token_hash)) {
    return { ok: false, response: json({ error: "Invalid inbox token" }, 403) };
  }

  return { ok: true, mailbox };
}

async function cleanupExpired(db) {
  const now = nowSeconds();
  await db.prepare(
    `DELETE FROM messages
     WHERE mailbox_id IN (
       SELECT id FROM mailboxes WHERE expires_at <= ?1
     )`
  ).bind(now).run();

  await db.prepare("DELETE FROM mailboxes WHERE expires_at <= ?1").bind(now).run();
}

function extractVerificationCodes(input) {
  const text = String(input || "").replace(/\s+/g, " ");
  const found = [];
  const seen = new Set();

  const add = (code, confidence = "possible") => {
    const normalized = String(code || "").trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!normalized || normalized.length < 4 || normalized.length > 10) return;
    if (!/[0-9]/.test(normalized)) return;
    const key = normalized.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ code: normalized, confidence });
  };

  const contextPatterns = [
    /(?:verification|verify|security|authentication|login|confirmation|confirm|one[- ]?time|otp|passcode|pin)\s*(?:code|number|password)?\s*(?:is|:|-)?\s*([A-Z0-9-]{4,10})/gi,
    /(?:code|otp|passcode|pin)\s*(?:is|:|-)\s*([A-Z0-9-]{4,10})/gi
  ];

  for (const pattern of contextPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) add(match[1], "high");
  }

  const numeric = /\b\d{4,8}\b/g;
  let match;
  while ((match = numeric.exec(text)) !== null) {
    add(match[0], found.length ? "possible" : "likely");
  }

  return found.slice(0, 8);
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function getDomains(env) {
  return String(env.MAIL_DOMAINS || "")
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
}

function getTtlHours(env) {
  const n = Number(env.MAILBOX_TTL_HOURS || 24);
  return Number.isFinite(n) && n > 0 && n <= 168 ? Math.floor(n) : 24;
}

function cleanString(value, max) {
  const str = String(value ?? "");
  return str.length > max ? str.slice(0, max) : str;
}

function normalizeAddress(address) {
  return String(address || "").trim().toLowerCase();
}

function getBearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function randomToken(bytes = 32) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return bytesToBase64Url(values);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
