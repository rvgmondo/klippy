# Turning on the cron jobs (digest, recurring billing, payment reminders)

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

### Payment reminders
Chases unpaid invoices so you do not have to: three days before due, on the due date,
then weekly once overdue. Only chases invoices that were actually sent, have a billing
email on the client, and are not yet paid. It records when it last chased each one, so
running it more than once a day sends nothing extra.

Run it AFTER the billing job, so invoices generated this morning are included.

- Common Settings: **Once Per Day** (e.g. minute `0`, hour `8`).
- Command (same secret):

```
curl -s -X POST -H "X-Cron-Key: YOUR_SECRET" https://klippy.mondobase.com/api/v1/cron/invoice-reminders > /dev/null 2>&1
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

Reminders return:
```json
{"ok":true,"considered":4,"sent":1}
```
- `considered` = unpaid sent invoices with an address, `sent` = how many were chased
  today. `sent: 0` is normal and usually correct: nothing was due in 3 days, due today,
  or a week past its last chase.

If any returns `{"error":"Bad cron key."}` the secret in the cron command does not
match `CRON_SECRET`. If it returns `{"error":"CRON_SECRET is not configured."}` the env
var is missing or the app was not restarted after adding it.

## 4. Email has to actually work

All three of these send email through the same mailer. If `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` are not set on the Node app, nothing is
delivered: the digest sends nothing, and invoices are generated but stay drafts
instead of going out. Set them in the same place as `CRON_SECRET` and restart.
