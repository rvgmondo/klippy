# Turning on PayFast (pay invoices online)

This lets a client pay an invoice by card or Instant EFT. When they pay, PayFast
notifies Klippy and the invoice marks itself paid. It ships **disabled** and should
be tested in sandbox before you trust it with a real client.

## 1. Add the encryption secret to the Node app

Your PayFast merchant key and passphrase are stored encrypted in the database. The
encryption key lives only in the app environment.

cPanel > Setup Node.js App > Klippy > Environment variables > Add:

| Name | Value |
|---|---|
| `PAYMENTS_SECRET` | a long random string (treat like a password, never commit it) |

Confirm `APP_URL` is set to `https://klippy.mondobase.com`, because the PayFast
notify and return URLs are built from it.

Click **Save**, then **Restart**.

## 2. Enter your PayFast credentials

Settings > **Payments**. While testing, use PayFast's sandbox merchant details from
<https://sandbox.payfast.co.za> and keep **Sandbox mode** on.

- Merchant ID
- Merchant key
- Passphrase (set the same one in your PayFast dashboard under Settings)

Leave **Enable PayFast on invoices** on once the keys are in.

## 3. Point PayFast at the notify URL

In your PayFast dashboard, the ITN (notify) URL is:

```
https://klippy.mondobase.com/api/v1/payfast/notify
```

Klippy also sends this on each payment, so a dashboard setting is a backstop.

## 4. Test in sandbox before going live

1. Open an unpaid invoice in Billing and click the card icon (**Open PayFast checkout**).
2. Complete the sandbox payment.
3. Back in Klippy, the invoice should flip to **Paid** within a minute (PayFast calls
   the notify URL server to server).

Only once that round trip works, switch **Sandbox mode** off and swap in your live
merchant credentials.

## What is not done yet

- **Auto-debit** (charging a saved card on a schedule) is scaffolded but not wired to
  the recurring billing job. Do not rely on it until it has been tested end to end.
- The in-app button opens checkout for testing. A public "Pay now" link inside the
  emailed invoice is a small follow-up once the sandbox round trip is confirmed.
