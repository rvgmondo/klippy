# Server settings (environment variables)

Everything Klippy reads from the server, what it does, and what happens without it.
On cPanel these go under **Setup Node.js App, your app, Environment variables**.
Press **Restart** after any change.

After deploying, open **Settings, Automation** in Klippy. The set-up check at the top
says, in green, amber or red, whether each of these is in place.

## Making a secret value

Several of these are "a long random value". Make one on your own computer and paste it
straight into cPanel. Never send it in chat or email.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run it once per secret, so each one is different.

## Never change these once set

| Setting | What breaks if it changes |
|---|---|
| `PAYMENTS_SECRET` | Saved cards, stored payment keys and calendar links can no longer be read. |
| `SOCIAL_TOKEN_KEY` | Every connected Facebook, Instagram and LinkedIn account has to be connected again. |
| `JWT_SECRET` | Everyone is signed out (harmless, but surprising). |

Keep a copy of these three somewhere safe, like a password manager.

## Required: Klippy will not run properly without these

| Setting | Example | What it is for |
|---|---|---|
| `DATABASE_URL` | `mysql://user:password@localhost:3306/klippy` | The database. |
| `JWT_SECRET` | a long random value | Signs people in. Without it the app will not start. |
| `NODE_ENV` | `production` | Turns on secure cookies and the production checks. |
| `APP_URL` | `https://klippy.mondobase.com` | The address used in every link in every email. If it is wrong, links in invoices, pay buttons and portal invites go nowhere. |
| `CORS_ORIGIN` | `https://klippy.mondobase.com` | The address the app is opened from. |

## Needed for the features you use

| Setting | Example | Without it |
|---|---|---|
| `SMTP_HOST` | `mail.mondobase.com` | No email leaves at all: invoices, reminders, statements, follow-ups and reports only go to a log. |
| `SMTP_PORT` | `465` (or `587`) | |
| `SMTP_USER` | `klippy@mondobase.com` | |
| `SMTP_PASS` | the mailbox password | |
| `SMTP_FROM` | `Klippy <klippy@mondobase.com>` | The default sender. Each business can still send as itself (Settings, Email sending). |
| `PAYMENTS_SECRET` | a long random value | Card payments, saved cards and reading your Outlook calendar do not work. |
| `CRON_SECRET` | a long random value | The wake-up cron is refused (see below). |
| `SOCIAL_TOKEN_KEY` | a long random value | Facebook, Instagram and LinkedIn cannot be connected. |

## The wake-up cron (not an environment variable, but essential)

cPanel puts the app to sleep when nobody is using it, and a sleeping app runs nothing:
no reminders, no recurring invoices, no follow-ups, no statements on the 1st. A cron
that knocks every 15 minutes keeps the daily work happening.

In cPanel, **Cron Jobs**, add one running every 15 minutes (`*/15 * * * *`):

```bash
curl -s -X POST -H "X-Cron-Key: YOUR_CRON_SECRET" https://klippy.mondobase.com/api/v1/cron/tick
```

Put your real `CRON_SECRET` where it says `YOUR_CRON_SECRET`. The set-up check shows
when it last knocked.

## Optional

| Setting | What it does |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Lets the installed app buzz your phone. Make a pair once by running `npx web-push generate-vapid-keys` inside the `api` folder, then paste both. |
| `VAPID_SUBJECT` | `mailto:you@mondobase.com`, the contact the push services see. |
| `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID` | Your Meta (Facebook and Instagram) app. You can also enter these in Klippy on Posts, Accounts tab, under App details, which is easier; what is entered in Klippy wins. |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | The same for LinkedIn. |
| `PUBLIC_MEDIA_BASE` | Only if Instagram says it cannot reach your images: the public address files are served from. Defaults to `APP_URL`. |
| `PLATFORM_ADMIN_EMAILS` | Your sign-in email, e.g. `ruben@mondobase.com` (comma-separated for more than one). Who may open Settings, Automation and run the platform's daily jobs. Without it Klippy guesses the owner of the oldest workspace on the server, which may be an old test workspace, so set it. |
| `COOKIE_DOMAIN` | Leave empty unless the app and API live on different subdomains. |
| `UPLOAD_DIR`, `STORAGE_DIR` | Where uploaded files are kept. The defaults are fine on cPanel. |
| `PORT` | Set by cPanel. Do not add it yourself. |

## Leave these alone

`AUTH_RATE_LIMIT_MAX`, `SOCIAL_DRY_RUN`, `META_API_VERSION`, `META_POLL_INTERVAL_MS`,
`LINKEDIN_VERSION` and `STORAGE_DRIVER` are for testing and development. Do not set
them on the live server.
