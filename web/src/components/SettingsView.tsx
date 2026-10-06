import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  User, Palette, Building2, Receipt, BellRing, Mail, Users, Building,
  CreditCard, Zap, Tag, KeyRound, StickyNote, Shield, LayoutGrid, FileText, Server, Trash2, Upload,
  Layers, Search, ArrowLeft, ChevronRight, Files,
  type LucideIcon,
} from 'lucide-react';
import { apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Business } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';
import { BusinessSettingsPanel, type BusinessSection } from './BusinessSettings';
import { ProfilePanel } from './ProfilePanel';
import { AppearancePanel } from './AppearancePanel';
import { BrandingPanel } from './BrandingPanel';
import { PeoplePanel } from './PeoplePanel';
import { TeamsPanel } from './TeamsPanel';
import { LabelsPanel } from './LabelsPanel';
import { TokensPanel } from './TokensPanel';
import { NotesPanel } from './NotesPanel';
import { ConnectionsPanel } from './ConnectionsPanel';
import { AccessGrid } from './AccessGrid';
import { AutomationPanel } from './AutomationPanel';
import { PaymentsPanel } from './PaymentsPanel';
import { HostingPanel } from './HostingPanel';
import { AccountPanel } from './AccountPanel';
import { ModulesPanel } from './ModulesPanel';
import { PdfDesignPanel } from './PdfDesignPanel';
import { TrashPanel } from './TrashPanel';
import { MessagingPanel } from './MessagingPanel';
import { ImportPanel } from './ImportPanel';

/**
 * Settings as a real page.
 *
 * Three groups, by who a setting belongs to: you, one business, and the workspace.
 * Each thing has ONE name in ONE place. Payments, SMS and hosting used to appear
 * twice, once per business and once for the workspace, under the same names, and
 * nobody could tell which one counted. The workspace versions are defaults that a
 * business falls back on, so they now live together on one page that says so, next
 * to the table of what each business actually uses.
 *
 * On a phone it is a menu first and one section after, with a way back, rather than
 * twenty-odd buttons stacked above whatever you came for.
 */

type DefaultsTab = 'uses' | 'payments' | 'messaging' | 'hosting' | 'brand';
type SectionId =
  | 'profile' | 'appearance'
  | `biz:${BusinessSection}` | 'biz:modules' | 'biz:pdf' | 'biz:payments' | 'biz:hosting' | 'biz:import'
  | 'account' | 'people' | 'teams' | 'defaults' | 'automation'
  | 'labels' | 'tokens' | 'notes' | 'trash';

interface Item { id: SectionId; label: string; icon: LucideIcon; hint: string; words?: string }

const YOU: Item[] = [
  { id: 'profile', label: 'Profile', icon: User, hint: 'Your name, email, password and daily email', words: 'password two-factor 2fa digest login' },
  { id: 'appearance', label: 'Appearance', icon: Palette, hint: 'Light or dark, and accent colour', words: 'theme colour color dark light' },
];

const BUSINESS: Item[] = [
  { id: 'biz:brand', label: 'Name and logo', icon: Building2, hint: 'What clients see at the top of every quote, invoice and email', words: 'brand colour color logo font' },
  { id: 'biz:invoicing', label: 'Business details', icon: Receipt, hint: 'Address, VAT number, bank details, currency and WhatsApp', words: 'vat tax bank address registration whatsapp currency' },
  { id: 'biz:documents', label: 'Invoices, quotes and credit notes', icon: Files, hint: 'Payment terms, how long quotes last, deposits, wording and numbering', words: 'invoice quote credit note terms footer deposit valid numbering prefix number due days' },
  { id: 'biz:pdf', label: 'Document look', icon: FileText, hint: 'How your quotes and invoices look as a PDF', words: 'pdf design template layout' },
  { id: 'biz:payments', label: 'Getting paid online', icon: CreditCard, hint: 'The card payment account this business is paid into', words: 'payfast card online pay now merchant debit' },
  { id: 'biz:reminders', label: 'Chasing unpaid invoices', icon: BellRing, hint: 'When reminders go out, and by email, SMS or WhatsApp', words: 'reminder overdue chase sms whatsapp suspend' },
  { id: 'biz:email', label: 'Email sending', icon: Mail, hint: 'The address this business sends from, and where replies go', words: 'smtp sender from reply' },
  { id: 'biz:hosting', label: 'Hosting', icon: Server, hint: 'Only if you sell hosting: the server new accounts are made on', words: 'whm cpanel server hosting' },
  { id: 'biz:modules', label: 'Features', icon: LayoutGrid, hint: 'Which parts of Klippy this business uses', words: 'modules deals posts calendar expenses' },
  { id: 'biz:access', label: 'Who can work here', icon: Shield, hint: 'Which people can see and work in this business', words: 'access members permissions' },
];
const BUSINESS_ADMIN: Item[] = [
  { id: 'biz:import', label: 'Import clients', icon: Upload, hint: 'Bring clients and old invoices over from Invoice Ninja', words: 'invoice ninja csv import' },
];

const WORKSPACE: Item[] = [
  { id: 'account', label: 'Workspace', icon: Building, hint: 'Its name, what you call clients, backups and deleting it', words: 'backup restore export download delete currency client word' },
  { id: 'people', label: 'People', icon: Users, hint: 'Who can sign in, and what they can see', words: 'invite users team members roles' },
  { id: 'teams', label: 'Teams', icon: Users, hint: 'Group people so work can be given to a team' },
  { id: 'defaults', label: 'Defaults for every business', icon: Layers, hint: 'Payments, SMS, hosting and a brand any business can fall back on', words: 'payfast sms whatsapp hosting whm fallback brand connections workspace default' },
  { id: 'automation', label: 'Automation', icon: Zap, hint: 'What Klippy does on its own, and when it last ran', words: 'jobs cron scheduled' },
  { id: 'labels', label: 'Labels', icon: Tag, hint: 'Labels for cards, shared across boards' },
  { id: 'tokens', label: 'API tokens', icon: KeyRound, hint: 'For scripts and other apps', words: 'api integration key' },
  { id: 'notes', label: 'Notes', icon: StickyNote, hint: 'Your private scratch notes' },
  { id: 'trash', label: 'Trash', icon: Trash2, hint: 'Deleted clients and boards, restorable for 30 days', words: 'deleted restore undo' },
];

/**
 * Old addresses still land somewhere sensible. Screens and emails link here with
 * ?s=..., and those links must keep working after the menu changes.
 */
const ALIASES: Record<string, { id: SectionId; tab?: DefaultsTab }> = {
  'biz:messaging': { id: 'biz:reminders' },
  payments: { id: 'defaults', tab: 'payments' },
  messaging: { id: 'defaults', tab: 'messaging' },
  hosting: { id: 'defaults', tab: 'hosting' },
  'account-brand': { id: 'defaults', tab: 'brand' },
  connections: { id: 'defaults', tab: 'uses' },
};

function readDeepLink(): { id: SectionId | null; tab: DefaultsTab } {
  const s = new URLSearchParams(window.location.search).get('s');
  if (!s) return { id: null, tab: 'uses' };
  const alias = ALIASES[s];
  return alias ? { id: alias.id, tab: alias.tab ?? 'uses' } : { id: s as SectionId, tab: 'uses' };
}

export function SettingsView({ businessId }: { businessId: BusinessSelection }) {
  const { user, account } = useAuth();
  const { data } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => apiGet<{ businesses: Business[] }>('/businesses'),
  });
  // Settings configure ANY business, not only the one picked in the header.
  const [settingsBiz, setSettingsBiz] = useState<number | null>(businessId === 'all' ? null : businessId);
  const bizList = data?.businesses ?? [];
  const focused = bizList.find((b) => b.id === (settingsBiz ?? bizList[0]?.id));
  const [link] = useState(readDeepLink);
  const [section, setSection] = useState<SectionId>(link.id ?? 'profile');
  const [defaultsTab, setDefaultsTab] = useState<DefaultsTab>(link.tab);
  // Phone only: whether a section is open (true) or the menu is showing.
  const [open, setOpen] = useState(!!link.id);
  const [q, setQ] = useState('');

  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const groups: { key: string; title: string; note: string; items: Item[] }[] = [
    { key: 'you', title: 'You', note: 'Only for you', items: YOU },
    ...(focused ? [{ key: 'biz', title: focused.name, note: 'What your clients see', items: isAdmin ? [...BUSINESS, ...BUSINESS_ADMIN] : BUSINESS }] : []),
    ...(isAdmin ? [{ key: 'ws', title: 'Workspace', note: 'Shared by every business and person', items: WORKSPACE }] : []),
  ];
  const all = groups.flatMap((g) => g.items);
  const current = all.find((i) => i.id === section) ?? all[0]!;

  // Matches the START of words, so "vat" finds VAT and not "private".
  const needles = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (i: Item) => {
    const words = `${i.label} ${i.hint} ${i.words ?? ''}`.toLowerCase().split(/[^a-z0-9]+/);
    return needles.every((n) => words.some((w) => w.startsWith(n)));
  };
  const shown = groups.map((g) => ({
    ...g, items: needles.length ? g.items.filter(matches) : g.items,
  })).filter((g) => g.items.length > 0);

  const pick = (id: SectionId) => { setSection(id); setOpen(true); };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <div className={`mb-5 ${open ? 'hidden lg:block' : ''}`}>
          <h1 className="font-display text-2xl font-bold text-slate-100">Settings</h1>
          <p className="mt-0.5 text-sm text-slate-500">Yours, each business's, and the workspace's.</p>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[250px_minmax(0,1fr)]">
          <nav className={`min-w-0 space-y-5 ${open ? 'hidden lg:block' : ''}`} aria-label="Settings sections">
            <label className="relative block">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a setting" aria-label="Find a setting"
                className="w-full rounded-lg border border-slate-700 bg-slate-900/70 py-2 pl-8 pr-3 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)]" />
            </label>
            {shown.length === 0 && <p className="px-2 text-sm text-slate-500">Nothing called that. Try another word.</p>}
            {shown.map((g) => (
              <div key={g.key}>
                <div className="mb-1.5 px-2">
                  <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g.title}</div>
                  <div className="truncate text-[11px] text-slate-600">{g.note}</div>
                  {g.key === 'biz' && bizList.length > 1 && (
                    <select value={focused?.id ?? ''} onChange={(e) => setSettingsBiz(Number(e.target.value))}
                      aria-label="Business to set up"
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900/70 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-[var(--accent)]">
                      {bizList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  )}
                </div>
                <div className="space-y-0.5">
                  {g.items.map((it) => {
                    const Icon = it.icon;
                    const active = it.id === current.id;
                    return (
                      <button key={it.id} onClick={() => pick(it.id)} aria-current={active ? 'page' : undefined}
                        className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors lg:min-h-0 ${
                          active ? 'lg:bg-[var(--accent-quiet)] lg:font-medium lg:text-[var(--accent)] text-slate-300' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                        }`}>
                        <Icon size={15} className="shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{it.label}</span>
                          {/* On a phone the hint is the only way to tell sections apart. */}
                          <span className="block truncate text-[11px] font-normal text-slate-500 lg:hidden">{it.hint}</span>
                        </span>
                        <ChevronRight size={14} className="shrink-0 text-slate-600 lg:hidden" />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          <div className={`min-w-0 ${open ? '' : 'hidden lg:block'}`}>
            <button onClick={() => setOpen(false)} className="mb-3 inline-flex min-h-9 items-center gap-1 text-sm text-[var(--accent)] lg:hidden">
              <ArrowLeft size={15} /> Settings
            </button>
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:p-5">
              <div className="mb-5 border-b border-slate-800 pb-3">
                <h2 className="text-base font-semibold text-slate-100">{current.label}</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {current.id.startsWith('biz:') && focused && bizList.length > 1 ? `${focused.name}. ` : ''}{current.hint}
                </p>
              </div>
              {/*
                The key is the whole fix, and it has to carry both the workspace and the
                business being configured.

                Every panel copies its fields into local state ONCE, when it first loads,
                while its Save reads the business id fresh on each render. With no key,
                changing the business kept the same component and only swapped the id:
                the fields still held business A while Save wrote to business B.
                Measured: B received A's bank details, VAT and registration numbers,
                currency, tax rate, reminder schedule, SMTP settings and PayFast merchant
                ID, and B's online payments were switched off, all under a normal "Saved".

                The workspace id is in the key for the same failure one level up.
                Remounting drops unsaved edits when the business changes, which is correct.
              */}
              <SectionBody
                key={`${account?.id ?? 'none'}:${current.id.startsWith('biz:') ? `biz:${focused?.id ?? 'none'}` : current.id}`}
                id={current.id} business={focused} defaultsTab={defaultsTab} onDefaultsTab={setDefaultsTab} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const DEFAULT_TABS: { id: DefaultsTab; label: string }[] = [
  { id: 'uses', label: 'What each business uses' },
  { id: 'payments', label: 'Online payments' },
  { id: 'messaging', label: 'SMS and WhatsApp' },
  { id: 'hosting', label: 'Hosting server' },
  { id: 'brand', label: 'Fallback brand' },
];

/**
 * The workspace-wide settings, which only matter for a business that has not set
 * its own. Said up front, because the same names exist per business and the
 * question everyone has is which one wins.
 */
function DefaultsPanel({ tab, onTab }: { tab: DefaultsTab; onTab: (t: DefaultsTab) => void }) {
  return (
    <div>
      <p className="mb-4 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
        A business uses its own settings first. These are only used by a business that has not set its own,
        so one card payment account or SMS sender can serve all of them. The first tab shows which one each business is using.
      </p>
      <div className="-mx-1 mb-4 flex gap-1 overflow-x-auto overflow-y-hidden px-1" role="tablist">
        {DEFAULT_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)}
            className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${tab === t.id
              ? 'bg-slate-800 font-medium text-slate-100' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'uses' && <ConnectionsPanel />}
      {tab === 'payments' && <PaymentsPanel />}
      {tab === 'messaging' && <MessagingPanel />}
      {tab === 'hosting' && <HostingPanel />}
      {tab === 'brand' && <BrandingPanel />}
    </div>
  );
}

function SectionBody({ id, business, defaultsTab, onDefaultsTab }: {
  id: SectionId; business?: Business; defaultsTab: DefaultsTab; onDefaultsTab: (t: DefaultsTab) => void;
}) {
  if (id.startsWith('biz:')) {
    if (!business) return <p className="text-sm text-slate-500">Add a business first.</p>;
    if (id === 'biz:modules') return <ModulesPanel business={business} />;
    if (id === 'biz:pdf') return <PdfDesignPanel business={business} />;
    if (id === 'biz:payments') return <PaymentsPanel businessId={business.id} />;
    if (id === 'biz:hosting') return <HostingPanel businessId={business.id} />;
    if (id === 'biz:import') return <ImportPanel business={business} />;
    if (id === 'biz:reminders') {
      // When to chase and how: one job, so one page.
      return (
        <div className="space-y-8">
          <BusinessSettingsPanel business={business} only="reminders" />
          <div className="border-t border-slate-800 pt-6">
            <MessagingPanel businessId={business.id} />
          </div>
        </div>
      );
    }
    return <BusinessSettingsPanel business={business} only={id.slice(4) as BusinessSection} />;
  }
  switch (id) {
    case 'profile': return <ProfilePanel />;
    case 'appearance': return <AppearancePanel />;
    case 'account': return <AccountPanel />;
    case 'people': return <><PeoplePanel /><AccessGrid /></>;
    case 'teams': return <TeamsPanel />;
    case 'defaults': return <DefaultsPanel tab={defaultsTab} onTab={onDefaultsTab} />;
    case 'automation': return <AutomationPanel />;
    case 'labels': return <LabelsPanel />;
    case 'tokens': return <TokensPanel />;
    case 'notes': return <NotesPanel />;
    case 'trash': return <TrashPanel />;
    default: return null;
  }
}
