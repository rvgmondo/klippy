# Turning on the cron jobs (digest email + recurring billing)

Both of these are cPanel cron jobs that call a protected endpoint, using the same
shared secret. If you already set up the digest, you only need to do step 2 again
(add one more cron job) - the secret and env vars are shared.

## 1. Add the secret to the Node app

cPanel > Setup Node.js App > Klippy > Environment variables > Add:

| Name | Value |
|---|---|
| `CRON_SECRET` | a long random string (treat like a password) |

Also confirm `APP_URL` is set to `https://klippy.mondobase.com` so the email links work.

Click **Save**, then **Restart** (env vars only load on restart).

## 2. Add the cron jobs

cPanel > **Cron Jobs** > Add New Cron Job. Add both of these as separate jobs.

### Morning digest
A daily email listing what is due today and what is overdue. Only sent to people who
have it enabled (Settings > Profile) and only when they actually have something due.

- Common Settings: **Once Per Day** (e.g. minute `0`, hour `7` for 07:00 server time).
- Command (replace `YOUR_SECRET` with the value from step 1):

```
curl -s -X POST -H "X-Cron-Key: YOUR_SECRET" https://klippy.mondobase.com/api/v1/cron/daily-digest > /dev/null 2>&1
```

### Recurring billing
Generates a draft invoice for every active subscription whose next bill date has
arrived, then rolls it forward a month. Safe to run more than once a day - anything
not yet due is simply skipped.

- Common Settings: **Once Per Day** is enough (subscriptions bill monthly either way).
- Command (same secret):

```
curl -s -X POST -H "X-Cron-Key: YOUR_SECRET" https://klippy.mondobase.com/api/v1/cron/bill-subscriptions > /dev/null 2>&1
```

## 3. Test without waiting

Run either command from cPanel Terminal, or temporarily set the cron to run in a
couple of minutes.

Digest returns:
```json
{"ok":true,"considered":1,"sent":1}
```
- `considered` = people with the digest enabled, `sent` = how many actually got mail.

Billing returns:
```json
{"ok":true,"due":2,"billed":2,"failed":0}
```
- `due` = subscriptions whose next bill date had arrived, `billed` = invoices actually
  created, `failed` = errored (check the app log for why - e.g. the client folder or
  offering was deleted).

If either returns `{"error":"Bad cron key."}` the secret in the cron command does not
match `CRON_SECRET`. If it returns `{"error":"CRON_SECRET is not configured."}` the env
var is missing or the app was not restarted after adding it.
