# Reading takings from a payment provider

Verified September 2026 against each provider's own reference, not their marketing.
Redo this before building any of the unbuilt ones: an API that existed in September
is not an API that exists today.

## The distinction that matters

**Charging** and **reading** are different capabilities and most providers do exactly
one well.

- A gateway you can **charge through** takes money on your behalf and pushes you a
  notification. That is `payment_settings` and the ITN/notify route. The money becomes
  a payment against an invoice.
- A provider you can **read from** tells you afterwards what a machine or a checkout
  took. That is `payment_connections` and the sales sync. The money becomes a sale.

Only the readable ones belong in the takings sync. Building a sync against a push-only
provider means polling an endpoint that does not exist.

## What each one actually gives you

| Provider | Can Klippy read it? | Reports the fee? | Notes |
|---|---|---|---|
| **Yoco** | Yes, `GET /v1/payments` | Yes, `processing_fees[]` | **Built.** Card machine and online. 31-day cap per query, so the sync walks month windows. Amounts in integer cents. |
| **Zapper** | Yes, transaction history by date range | Yes, and better than anyone | `processingFeeAmount`, its percentage and fixed parts, `processingFeeTax`, plus `settlementAmount` / `settlementStatus` / `settlementUTCDate`. The fee tax is input VAT you can claim back. Their docs warn that polling may be throttled. |
| **Paystack** | Yes, transaction list | Yes, `fees` in the currency subunit | |
| **Peach Payments** | Yes, Reconciliation API | Yes, fees, refunds and reversals per deposit | Also a per-payment status query. |
| **SnapScan** | Yes, `GET pos.snapscan.io/merchant/api/v1/payments` | **No.** No fee field exists | You would see turnover with no cost against it. That is the exact illusion the Takings screen was built to prevent, so it has to be labelled rather than quietly integrated. Cash-ups exist for period reconciliation. |
| **PayFast** | **No read API at all** | Only on the ITN: `amount_fee`, `amount_net` | Push only. The fee reaches you once, at the moment of payment, or never. That is why it is captured on the ITN. |
| **Ozow** | Lookup by reference and status polling only | Not found | No merchant transaction list. Same shape as PayFast. |
| **iKhokha** | **Unverified** | Unknown | The developer portal renders behind a script and could not be read without a merchant login. The public page describes iK Pay as accepting payments, with no evidence of a transaction list. Not listed as available rather than guessed at. |

## Adding one

`lib/salesProviders.ts` is the registry. A provider with a `client` attached works
everywhere sales already work: the screen, the nightly job, the VAT return. So adding
one is:

1. Write the client (model it on `lib/yoco.ts`): list payments in a date range with
   whatever paging they use, convert their amounts to major units, classify errors as
   retryable or not.
2. Attach it to the registry entry.
3. Add a stubbed response to `tests/sales.e2e.mjs` in the exact shape their reference
   documents.

No migration: `0066` already widened both enums to the verified-readable set. No route
change, no sync change.

## The rule that produced this list

A provider that cannot tell you what it kept is not a finance integration, it is a
turnover feed. Gross without fees reads better than the bank does, and a shop that
believes the gross is what it earned prices its stock wrong. Where a provider does not
report the fee, say so on the screen rather than showing a zero.
