# Turning on the morning digest email

The digest is a daily email listing what is due today and what is overdue. It is only
sent to people who have it enabled (Settings > Profile) and only when they actually have
something due, so it never nags with an empty message.

It runs from a cPanel cron job that calls a protected endpoint.

## 1. Add the secret to the Node app

cPanel > Setup Node.js App > Klippy > Environment variables > Add:

| Name | Value |
|---|---|
| `CRON_SECRET` | a long random string (treat like a password) |

Also confirm `APP_URL` is set to `https://klippy.mondobase.com` so the email links work.

Click **Save**, then **Restart** (env vars only load on restart).

## 2. Add the cron job

cPanel > **Cron Jobs** > Add New Cron Job.

- Common Settings: **Once Per Day** (or set the minute/hour you want the mail to land,
  e.g. minute `0`, hour `7` for 07:00 server time).
- Command (replace `YOUR_SECRET` with the value from step 1):

```
curl -s -X POST -H "X-Cron-Key: YOUR_SECRET" https://klippy.mondobase.com/api/v1/cron/daily-digest > /dev/null 2>&1
```

## 3. Test it without waiting for morning

Run the same command from cPanel Terminal, or temporarily set the cron to run in a couple
of minutes. A successful call returns:

```json
{"ok":true,"considered":1,"sent":1}
```

- `considered` = people with the digest enabled
- `sent` = how many actually got mail (people with nothing due are skipped)

If it returns `{"error":"Bad cron key."}` the secret in the cron command does not match
`CRON_SECRET`. If it returns `{"error":"CRON_SECRET is not configured."}` the env var is
missing or the app was not restarted after adding it.
