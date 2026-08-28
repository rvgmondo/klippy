import { createHash } from 'node:crypto';

/**
 * PayFast integration (South African payment gateway).
 *
 * Two flows:
 *  1. Redirect to checkout: build a signed set of fields and send the client to
 *     PayFast's process page. They pay, PayFast calls our notify URL (ITN).
 *  2. ITN (Instant Transaction Notification): PayFast POSTs the result to us. We
 *     verify it three ways before trusting it (signature, amount, and a
 *     server-to-server confirmation), then mark the invoice paid.
 *
 * The signature scheme follows PayFast's own published Node example exactly:
 * urlencode each value (spaces as +), join in field order, append the passphrase,
 * MD5. Matching their encoding to the character is the whole game; a mismatch just
 * reads as "signature invalid" with no hint why.
 *
 * NOTE: written to PayFast's documented spec but NOT run against their sandbox
 * from here. It ships disabled (paymentSettings.enabled defaults false). Do a full
 * sandbox payment before trusting it live.
 */

export interface PayfastCreds {
  merchantId: string;
  merchantKey: string;
  passphrase: string | null;
  sandbox: boolean;
}

export const processUrl = (sandbox: boolean) => `https://${sandbox ? 'sandbox.payfast.co.za' : 'www.payfast.co.za'}/eng/process`;
export const validateUrl = (sandbox: boolean) => `https://${sandbox ? 'sandbox.payfast.co.za' : 'www.payfast.co.za'}/eng/query/validate`;

/** urlencode a value the way PayFast expects (PHP urlencode: spaces become +). */
function enc(v: string): string {
  return encodeURIComponent(v.trim()).replace(/%20/g, '+');
}

/**
 * Signature over an ordered set of fields. `signature` is never included, and
 * empty values are skipped (PayFast omits them from their own string too).
 */
export function signature(fields: Record<string, string>, passphrase: string | null): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'signature') continue;
    if (v === '' || v == null) continue;
    parts.push(`${k}=${enc(v)}`);
  }
  let str = parts.join('&');
  if (passphrase) str += `&passphrase=${enc(passphrase)}`;
  return createHash('md5').update(str).digest('hex');
}

export interface CheckoutInput {
  amount: number;          // in the account currency (ZAR)
  itemName: string;        // e.g. "Invoice INV-0001"
  mPaymentId: string;      // our reference back to the document
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
  buyerEmail?: string | null;
  /** true => ask PayFast to tokenize for later auto-debit (subscription_type 2). */
  tokenize?: boolean;
}

/**
 * Build the signed fields to send to PayFast's process page. Field ORDER matters:
 * the signature is computed over the fields in the order they are added here, and
 * PayFast recomputes in the same documented order.
 */
export function buildCheckout(creds: PayfastCreds, input: CheckoutInput): { url: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {
    merchant_id: creds.merchantId,
    merchant_key: creds.merchantKey,
    return_url: input.returnUrl,
    cancel_url: input.cancelUrl,
    notify_url: input.notifyUrl,
  };
  if (input.buyerEmail) fields.email_address = input.buyerEmail;
  fields.m_payment_id = input.mPaymentId;
  fields.amount = input.amount.toFixed(2);
  fields.item_name = input.itemName;
  if (input.tokenize) {
    // subscription_type 2 = tokenization: one charge now, a reusable token back in
    // the ITN for charging later. This is the auto-debit path.
    fields.subscription_type = '2';
  }
  fields.signature = signature(fields, creds.passphrase);
  return { url: processUrl(creds.sandbox), fields };
}

/** Verify the signature on an incoming ITN against our stored passphrase. */
export function verifyItnSignature(body: Record<string, string>, passphrase: string | null): boolean {
  const given = body.signature;
  if (!given) return false;
  return signature(body, passphrase) === given.toLowerCase();
}

/**
 * Fourth ITN check: hand the exact payload back to PayFast and let them confirm it
 * is one they sent. Only a literal "VALID" reply passes.
 *
 * The answer is a discriminated result rather than a boolean because the two ways
 * of failing are opposites, and collapsing them into `false` threw away real money:
 * "PayFast says this is not ours" is a forgery and must be rejected forever, while
 * "we could not reach PayFast" is a blip on our side that says nothing about the
 * payment. A single outbound hiccup used to permanently reject a genuine, signed,
 * COMPLETE payment. The caller retries the second and never the first.
 *
 * `unreachable` is set ONLY inside the catch. A `boolean | 'unreachable'` union
 * would be worse than the bug: any surviving `if (!ok)` would read the truthy
 * string as success and accept an unverified notification.
 */
export type ItnValidation = { ok: true } | { ok: false; reason: 'invalid' | 'unreachable' };

export async function validateItnWithServer(rawBody: string, sandbox: boolean): Promise<ItnValidation> {
  try {
    const res = await fetch(validateUrl(sandbox), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: rawBody,
    });
    const text = (await res.text()).trim();
    return text === 'VALID' ? { ok: true } : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/**
 * Signature for PayFast's server API, which is NOT the same rule as the checkout
 * above and is the usual reason an adhoc charge comes back rejected.
 *
 * The checkout signs its fields in the order they are sent. The server API instead
 * signs the header parameters AND the body parameters together, sorted
 * alphabetically by key, with the passphrase in the sort rather than appended at
 * the end. Two separate rules in one integration is a trap, so they are two
 * separate functions here rather than one with a flag.
 */
export function apiSignature(params: Record<string, string>, passphrase: string | null): string {
  const all: Record<string, string> = { ...params };
  if (passphrase) all.passphrase = passphrase;
  const str = Object.keys(all).sort()
    .filter((k) => all[k] !== '' && all[k] != null)
    .map((k) => `${k}=${enc(all[k] as string)}`)
    .join('&');
  return createHash('md5').update(str).digest('hex');
}

/**
 * Charge a stored token: take money for a later subscription cycle without the
 * client present. This is the highest-consequence call in Klippy, so read the
 * caller's rails in lib/autoDebit.ts before changing anything here.
 *
 * Amount is in CENTS, which is the other classic way to get this wrong: the
 * checkout endpoint wants rands with two decimals, this one wants an integer
 * number of cents. Passing 150.00 here would charge R1.50, and passing 15000 to
 * the checkout would charge fifteen thousand rand.
 *
 * Honest status: the signing rule below follows PayFast's documented server API,
 * but this specific call has not been exercised against a real merchant account
 * from here. That is exactly what dry-run mode is for.
 */
export async function chargeToken(
  creds: PayfastCreds, token: string, amountCents: number, itemName: string, reference?: string,
): Promise<{ ok: boolean; message: string; pfPaymentId?: string }> {
  if (!token) return { ok: false, message: 'No saved card for this subscription.' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, message: `Refusing to charge a nonsense amount (${amountCents} cents).` };
  }

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '+02:00');
  const headerParams: Record<string, string> = {
    'merchant-id': creds.merchantId,
    version: 'v1',
    timestamp,
  };
  const bodyParams: Record<string, string> = {
    amount: String(amountCents),
    item_name: itemName.slice(0, 100),
    ...(reference ? { m_payment_id: reference } : {}),
  };
  const sig = apiSignature({ ...headerParams, ...bodyParams }, creds.passphrase);

  // `testing=true` is how the server API is exercised without moving money. It is
  // tied to sandbox mode so a sandbox account can never take a real payment.
  const url = `https://api.payfast.co.za/subscriptions/${encodeURIComponent(token)}/adhoc`
    + (creds.sandbox ? '?testing=true' : '');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headerParams,
        signature: sig,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(bodyParams).toString(),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    type AdhocReply = { status?: string; data?: { response?: unknown } };
    let parsed: AdhocReply | null = null;
    try { parsed = JSON.parse(text) as AdhocReply; } catch { /* keep the raw text */ }

    if (!res.ok || parsed?.status !== 'success') {
      return { ok: false, message: `PayFast refused the charge (HTTP ${res.status}): ${text.slice(0, 300)}` };
    }
    const pfPaymentId = typeof parsed?.data?.response === 'string' || typeof parsed?.data?.response === 'number'
      ? String(parsed.data.response) : undefined;
    return { ok: true, message: 'Charged.', pfPaymentId };
  } catch (err) {
    // A timeout is the dangerous case: the charge may well have gone through. Say so
    // rather than reporting a clean failure, because the caller must not retry it.
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Could not reach PayFast (${why}). Treat as UNKNOWN, not as a failure: the charge may have gone through. Check PayFast before retrying.` };
  }
}
