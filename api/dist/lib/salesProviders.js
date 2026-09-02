import { listPayments as yocoList, testKey as yocoTest, MAX_WINDOW_DAYS as YOCO_WINDOW } from './yoco.js';
export const SALES_PROVIDERS = [
    {
        key: 'yoco',
        label: 'Yoco',
        credentialLabel: 'Yoco API key',
        reportsFees: true,
        maxWindowDays: YOCO_WINDOW,
        client: { listPayments: yocoList, testKey: yocoTest },
        note: 'Card machine and online payments, with the processing fee on each one.',
    },
    {
        key: 'zapper',
        label: 'Zapper',
        credentialLabel: 'Zapper merchant API key',
        reportsFees: true,
        maxWindowDays: null,
        client: null,
        note: 'Reports the fee, the tax on the fee, and what was settled to the bank. Not connected yet.',
    },
    {
        key: 'paystack',
        label: 'Paystack',
        credentialLabel: 'Paystack secret key',
        reportsFees: true,
        maxWindowDays: null,
        client: null,
        note: 'Online payments with the fee on each transaction. Not connected yet.',
    },
    {
        key: 'peach',
        label: 'Peach Payments',
        credentialLabel: 'Peach entity ID and access token',
        reportsFees: true,
        maxWindowDays: null,
        client: null,
        note: 'Reconciliation API listing transactions, fees and refunds per deposit. Not connected yet.',
    },
    {
        key: 'snapscan',
        label: 'SnapScan',
        credentialLabel: 'SnapScan API key',
        // The one that has to be said out loud.
        reportsFees: false,
        maxWindowDays: null,
        client: null,
        note: 'SnapScan does not report what it charged you, so takings would show with no cost against them. Not connected yet.',
    },
];
const BY_KEY = new Map(SALES_PROVIDERS.map((p) => [p.key, p]));
export const providerFor = (key) => BY_KEY.get(key);
/** The ones a person can actually connect today, i.e. those with a client written. */
export const connectableProviders = () => SALES_PROVIDERS.filter((p) => p.client !== null);
export const isConnectable = (key) => !!providerFor(key)?.client;
//# sourceMappingURL=salesProviders.js.map