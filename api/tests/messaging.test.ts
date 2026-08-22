import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizePhone, whatsappLink, reminderText, templateParams } from '../src/lib/messaging.js';

describe('normalizePhone', () => {
  it('turns South African local numbers into E.164 digits', () => {
    expect(normalizePhone('082 123 4567')).toBe('27821234567');
    expect(normalizePhone('0821234567')).toBe('27821234567');
    expect(normalizePhone('(082) 123-4567')).toBe('27821234567');
  });
  it('keeps a country code that is already there', () => {
    expect(normalizePhone('+27 82 123 4567')).toBe('27821234567');
    expect(normalizePhone('27821234567')).toBe('27821234567');
    expect(normalizePhone('0027821234567')).toBe('27821234567');
    expect(normalizePhone('+44 7700 900123')).toBe('447700900123');
  });
  it('refuses nothing and nonsense', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('call me')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
  });
});

describe('whatsappLink + text', () => {
  it('builds a wa.me link with the message encoded', () => {
    const url = whatsappLink('27821234567', 'Hi there, pay here: https://x.y/z?t=1&u=2');
    expect(url.startsWith('https://wa.me/27821234567?text=')).toBe(true);
    expect(decodeURIComponent(url.split('text=')[1]!)).toBe('Hi there, pay here: https://x.y/z?t=1&u=2');
  });
  it('writes one reminder that reads as an SMS', () => {
    const text = reminderText({
      clientName: 'Acme', number: 'INV-0009', amount: 'ZAR 1,500.00',
      whenPhrase: 'was due on 2026-08-01 (3 days ago)', link: 'https://k.example/pay/9?t=abc', brand: 'Mondobase',
    });
    expect(text).toBe('Hi Acme, invoice INV-0009 for ZAR 1,500.00 was due on 2026-08-01 (3 days ago). Pay here: https://k.example/pay/9?t=abc If it is already paid, please ignore this. Mondobase');
    expect(templateParams({ clientName: 'Acme', number: 'INV-1', amount: 'ZAR 1.00', whenPhrase: 'is due today', link: null, brand: 'B' }))
      .toEqual(['Acme', 'INV-1', 'ZAR 1.00', 'is due today', 'your invoice']);
  });
});

describe('providers', () => {
  const realFetch = globalThis.fetch;
  let calls: { url: string; init: RequestInit }[] = [];
  beforeEach(() => {
    calls = [];
    process.env.PAYMENTS_SECRET = 'test-secret-key-32-bytes-long-000';
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('{"ok":true}', { status: 201 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('posts the BulkSMS shape with basic auth from the token pair', async () => {
    const { encryptSecret } = await import('../src/lib/secretbox.js');
    const { sendSms } = await import('../src/lib/messaging.js');
    const row = {
      smsProvider: 'bulksms', smsTokenId: 'tok', smsTokenSecretEnc: encryptSecret('sec'), smsSender: 'Klippy',
    } as never;
    await sendSms(row, '27821234567', 'hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.bulksms.com/v1/messages');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('tok:sec').toString('base64')}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ to: '+27821234567', body: 'hello', from: 'Klippy' });
  });

  it('posts a WhatsApp template with the five ordered variables', async () => {
    const { encryptSecret } = await import('../src/lib/secretbox.js');
    const { sendWhatsAppTemplate } = await import('../src/lib/messaging.js');
    const row = {
      waPhoneNumberId: '1234567890', waAccessTokenEnc: encryptSecret('EAAtoken'),
      waTemplateName: 'invoice_reminder', waTemplateLang: 'en',
    } as never;
    await sendWhatsAppTemplate(row, '27821234567', ['Acme', 'INV-1', 'ZAR 1.00', 'is due today', 'https://l']);
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer EAAtoken');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('27821234567');
    expect(body.template.name).toBe('invoice_reminder');
    expect(body.template.components[0].parameters.map((p: { text: string }) => p.text))
      .toEqual(['Acme', 'INV-1', 'ZAR 1.00', 'is due today', 'https://l']);
  });

  it('surfaces a provider refusal as an error with the status', async () => {
    globalThis.fetch = vi.fn(async () => new Response('bad token', { status: 401 })) as unknown as typeof fetch;
    const { encryptSecret } = await import('../src/lib/secretbox.js');
    const { sendSms } = await import('../src/lib/messaging.js');
    const row = { smsProvider: 'bulksms', smsTokenId: 't', smsTokenSecretEnc: encryptSecret('s'), smsSender: null } as never;
    await expect(sendSms(row, '27821234567', 'x')).rejects.toThrow(/BulkSMS 401/);
  });
});
