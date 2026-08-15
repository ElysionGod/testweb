# OLCH Temp Mail

A disposable email inbox for **domains you own/control**.

## What it does

- Choose a custom mailbox name
- Choose from your configured domains
- Creates a private temporary inbox
- Receives incoming messages through Cloudflare Email Routing / Email Workers
- Stores messages in Cloudflare D1
- Detects likely OTP / verification codes
- Auto-refreshes the inbox every 4 seconds
- Displays a safe text view and a sandboxed/sanitized HTML view
- Auto-expires temporary inboxes (default: 24 hours)

> Important: this does not intercept mail for other people's addresses or domains.
> A website may also refuse known disposable-email domains, so no service can guarantee
> acceptance by every third-party website.

## Architecture

Browser
  → Cloudflare Worker API
  → D1 database

Internet email
  → Your domain MX / Cloudflare Email Routing
  → Email Worker `email()` handler
  → D1
  → Browser inbox

## 1. Requirements

- Node.js
- A Cloudflare account
- A domain you own and can add to Cloudflare
- Cloudflare Email Routing enabled for that domain

## 2. Install

```bash
npm install
```

## 3. Create the D1 database

```bash
npx wrangler d1 create olch-temp-mail-db
```

Cloudflare returns a database ID. Put that ID into:

```text
wrangler.jsonc
```

Replace:

```text
REPLACE_WITH_YOUR_D1_DATABASE_ID
```

## 4. Configure your domains

Edit `MAIL_DOMAINS` in `wrangler.jsonc`.

Example:

```json
"MAIL_DOMAINS": "mail.yourdomain.com,temp.yourdomain.com"
```

Every domain/subdomain shown in the website must actually be configured to receive mail
through Cloudflare Email Routing.

## 5. Initialize D1

For local development:

```bash
npm run db:init:local
```

For production:

```bash
npm run db:init:remote
```

## 6. Configure incoming email in Cloudflare

For each domain you want to use:

1. Add/onboard the domain in Cloudflare Email Routing.
2. Allow Cloudflare to configure the required mail DNS records.
3. Create or enable a **catch-all** routing rule.
4. Route the catch-all to this Email Worker.
5. Deploy this Worker.

The Worker checks whether the destination address was actually created in the web UI.
Unknown addresses are rejected.

## 7. Deploy

```bash
npm run deploy
```

Cloudflare will deploy both:

- the Worker (`src/index.js`)
- the static frontend (`public/`)

## 8. How to use

1. Open your deployed website.
2. Enter a mailbox name, for example `oussama`.
3. Select one of your domains.
4. Click **Create inbox**.
5. Use the generated address on a website you are signing into/creating an account on.
6. When the website emails that address, the message appears automatically.
7. If an OTP is detected, the code appears prominently with a Copy button.

## Security choices included

- Inbox access uses a random secret token.
- Only a SHA-256 hash of that token is stored in D1.
- Unknown/uncreated mailbox addresses are rejected.
- HTML email is rendered in a sandboxed iframe.
- The frontend removes active scripts/forms and blocks remote images from HTML emails.
- Temporary inboxes expire automatically.

## Recommended production hardening

For a public service, also add:

- Cloudflare Turnstile on mailbox creation
- Rate limiting per IP
- Abuse reporting
- Sender/message size limits
- Retention and privacy policy
- Optional per-user accounts if you want persistent inboxes

## Test incoming mail locally

Run:

```bash
npm run dev
```

Cloudflare Wrangler exposes a local email-handler endpoint during Email Worker development.
You can send a raw RFC 5322 test message to the local Email Worker endpoint.

Example message body:

```text
From: Test <sender@example.com>
To: your-created-address@your-domain.example
Subject: Your verification code is 482913
Message-ID: <test-001@example.com>
Content-Type: text/plain; charset=UTF-8

Your verification code is 482913.
```

Use the exact local endpoint shown by your installed Wrangler version.

## Project files

```text
olch-temp-mail/
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ src/
│  └─ index.js
├─ package.json
├─ schema.sql
├─ wrangler.jsonc
└─ README.md
```
