import { createHash } from 'node:crypto';

/**
 * PayFast integration (South African payment gateway).
 *
 * Two flows:
 *  1. Redirect to checkout: build a signed set of fields and send the client to
 *     PayFast's process page. They pay, PayFast calls our notify URL (ITN).
 *  2. ITN (Instant Transaction Notification): PayFast POSTs the result to us. We
 *     verify it four ways before trusting it (signature, source, amount, and a
 *     server-to-server confirmation), then mark the invoice paid.
 *
 * The signature scheme follows PayFast's own published Node example exactly:
 * urlencode each value (spaces as +), join in field order, append the passphrase,
 * MD5. Matching their encoding to the character is the whole game; a mismatch just
 * reads as "signature invalid" with no hint why.
 *
 * NOTE: This code is written to PayFast's documented spec but has NOT been run
 * against their sandbox in this environment. It ships disabled (paymentSettings
 * .enabled defaults false). Do a full sandbox payment before trusting it live.
 */

export interface PayfastCreds {
  merchantId: string;
  merchantKey: string;
  passphrase: string | null;
  sandbox: boolean;
}

export const processUrl = (sandbox: boolean) => `https://${sandbox ? 'sandbox.payfast.co.za' : 'www.payfast.co.za'}/eng/process`;
export const validateUrl = (sandbox: boolean) => `https://${sandbox ? 'sandbox.payfast.co.za' : 'www.payfast.co.za'}/eng/query/validate`;

/** PayFast's servers, for checking an ITN really came from them. */
export const VALID_ITN_HOSTS = [
  'www.payfast.co.za', 'sandbox.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za',
];

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
 * is one they sent. Returns true only on a literal "VALID" reply.
 */
export async function validateItnWithServer(rawBody: string, sandbox: boolean): Promise<boolean> {
  try {
    const res = await fetch(validateUrl(sandbox), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: rawBody,
    });
    const text = (await res.text()).trim();
    return text === 'VALID';
  } catch {
    return false;
  }
}

export function isValidItnHost(host: string | undefined): boolean {
  if (!host) return false;
  return VALID_ITN_HOSTS.includes(host.toLowerCase());
}

/**
 * Charge a stored token (auto-debit a later subscription cycle) without the client
 * present. This uses PayFast's separate server API, whose request signing differs
 * from the checkout above (it signs sorted headers + body).
 *
 * SCAFFOLD ONLY: the adhoc API signing has real edge cases and this has not been
 * exercised against the sandbox. Do not enable auto-debit until this specific call
 * has been tested end to end.
 */
export async function chargeToken(
  _creds: PayfastCreds, _token: string, _amountCents: number, _itemName: string,
): Promise<{ ok: boolean; message: string }> {
  return {
    ok: false,
    message: 'Auto-debit charging is scaffolded but not yet tested against PayFast. Enable after sandbox testing.',
  };
}
