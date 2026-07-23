# Deploying this release (labels, team, search, assignees, precise DnD, password reset)

This update touches the database, the API, and the web app, so all three steps below
are needed. Do them in order.

## 1. Database (one last manual import - then never again)
This release makes the app apply its own database migrations on startup. But your
live database was set up from `schema.sql`, which left no migration record, so we
reconcile it once.

phpMyAdmin > select your Klippy database > Import > choose `reconcile-to-managed.sql` > Go.
This adds the labels tables + password-reset columns AND marks the schema as
"managed", so from your NEXT update onward there is no database step at all - the
app updates its own schema when it restarts.

## 2. API
File Manager > `/home/novelcom/klippy.mondobase.com/klippy_api` >
upload `klippy-api.zip`, Extract, overwrite.
Then Setup Node.js App:
- **Run NPM Install** (this release adds the `nodemailer` package, so it's required)
- **Restart**

### New environment variables (optional but recommended)
Add these in Setup Node.js App so password-reset emails actually send and links point
to your live site:

| Name | Value |
|---|---|
| `APP_URL` | `https://klippy.mondobase.com` |
| `SMTP_HOST` | your mail host, e.g. `mail.mondobase.com` |
| `SMTP_PORT` | `465` (SSL) or `587` (TLS) |
| `SMTP_USER` | a mailbox you created in cPanel, e.g. `no-reply@mondobase.com` |
| `SMTP_PASS` | that mailbox's password |
| `SMTP_FROM` | `Klippy <no-reply@mondobase.com>` |

You can create the mailbox in cPanel > Email Accounts. Without these, everything else
works, but "Forgot password" will not deliver an email (the link only gets logged
server-side). `APP_URL` alone is worth setting either way.

## 3. Web
File Manager > `/home/novelcom/klippy.mondobase.com/` (docroot) >
upload `klippy-web.zip`, Extract, overwrite. Hard-refresh (Ctrl+Shift+R).

## Verify
- `https://klippy.mondobase.com/api/v1/health` still returns JSON.
- Log in, open a card: you should see Assignee, Labels, Time, and Attachments.
- Top bar has a Search box; the gear opens Settings with Workspace / People / Labels tabs.
- Drag a card and drop it between two other cards: it lands exactly there.
