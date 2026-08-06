import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  User, Palette, Building2, Receipt, BellRing, Mail, Users, Building,
  CreditCard, Zap, Tag, KeyRound, StickyNote, Shield, LayoutGrid, type LucideIcon,
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
import { AutomationPanel } from './AutomationPanel';
import { PaymentsPanel } from './PaymentsPanel';
import { AccountPanel } from './AccountPanel';
import { ModulesPanel } from './ModulesPanel';

/**
 * Settings as a real page.
 *
 * It used to be eleven tabs scrolling sideways inside a small modal, with a
 * business's own settings in a second modal on top. That hid things and made the
 * two levels feel like one. Here they are separated by who they belong to: you,
 * the business you are working in, and the account everyone shares. One section
 * on screen at a time, so nothing is a wall of fields.
 */

type SectionId =
  | 'profile' | 'appearance'
  | `biz:${BusinessSection}` | 'biz:modules'
  | 'account' | 'account-brand' | 'people' | 'teams' | 'payments' | 'automation'
  | 'labels' | 'tokens' | 'notes';

interface Item { id: SectionId; label: string; icon: LucideIcon; hint?: string }

const YOU: Item[] = [
  { id: 'profile', label: 'Profile', icon: User, hint: 'Your name, email and password' },
  { id: 'appearance', label: 'Appearance', icon: Palette, hint: 'Theme and accent colour' },
];

const BUSINESS: Item[] = [
  { id: 'biz:modules', label: 'Modules', icon: LayoutGrid, hint: 'Which parts of Klippy this business uses' },
  { id: 'biz:brand', label: 'Brand', icon: Building2, hint: 'Logo, display name and brand colour' },
  { id: 'biz:invoicing', label: 'Invoicing', icon: Receipt, hint: 'Address, VAT number, bank details and terms' },
  { id: 'biz:reminders', label: 'Payment reminders', icon: BellRing, hint: 'When unpaid invoices get chased' },
  { id: 'biz:email', label: 'Email', icon: Mail, hint: 'What this business sends from' },
  { id: 'biz:access', label: 'Access', icon: Shield, hint: 'Who can work in this business' },
];

const ACCOUNT: Item[] = [
  { id: 'account', label: 'Account', icon: Building, hint: 'Account name and what you call clients' },
  { id: 'account-brand', label: 'Fallback brand', icon: Palette, hint: 'Used by a business with no brand of its own' },
  { id: 'people', label: 'People', icon: Users, hint: 'Who can sign in' },
  { id: 'teams', label: 'Teams', icon: Users, hint: 'Group people for assignment' },
  { id: 'payments', label: 'Payments', icon: CreditCard, hint: 'PayFast and online payment links' },
  { id: 'automation', label: 'Automation', icon: Zap, hint: 'Scheduled jobs and when they last ran' },
  { id: 'labels', label: 'Labels', icon: Tag, hint: 'Card labels shared across boards' },
  { id: 'tokens', label: 'API tokens', icon: KeyRound, hint: 'For scripts and integrations' },
  { id: 'notes', label: 'Notes', icon: StickyNote, hint: 'Your private scratch notes' },
];

export function SettingsView({ businessId }: { businessId: BusinessSelection }) {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => apiGet<{ businesses: Business[] }>('/businesses'),
  });
  const focused = businessId === 'all' ? undefined : data?.businesses.find((b) => b.id === businessId);
  const [section, setSection] = useState<SectionId>('profile');

  // Only account admins have anything to do in the account group.
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const groups: { title: string; note?: string; items: Item[] }[] = [
    { title: 'You', items: YOU },
    ...(focused ? [{ title: focused.name, note: 'What your clients see', items: BUSINESS }] : []),
    ...(isAdmin ? [{ title: 'Account', note: 'Shared by everyone', items: ACCOUNT }] : []),
  ];

  const all = groups.flatMap((g) => g.items);
  const current = all.find((i) => i.id === section) ?? all[0]!;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <div className="mb-5">
          <h1 className="font-display text-2xl font-bold text-slate-100">Settings</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {focused
              ? <>Your preferences, {focused.name}'s identity, and the account you share.</>
              : <>Your preferences and the account you share. Focus a business to edit its brand and invoicing.</>}
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          {/* Section nav */}
          <nav className="space-y-5">
            {groups.map((g) => (
              <div key={g.title}>
                <div className="mb-1.5 px-2">
                  <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g.title}</div>
                  {g.note && <div className="truncate text-[10px] text-slate-600">{g.note}</div>}
                </div>
                <div className="space-y-0.5">
                  {g.items.map((it) => {
                    const Icon = it.icon;
                    const active = it.id === current.id;
                    return (
                      <button key={it.id} onClick={() => setSection(it.id)}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                          active ? 'bg-[var(--accent-quiet)] font-medium text-[var(--accent)]' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                        }`}>
                        <Icon size={15} className="shrink-0" />
                        <span className="truncate">{it.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* The one section on screen */}
          <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
            <div className="mb-5 border-b border-slate-800 pb-3">
              <h2 className="text-base font-semibold text-slate-100">{current.label}</h2>
              {current.hint && <p className="mt-0.5 text-xs text-slate-500">{current.hint}</p>}
            </div>
            <SectionBody id={current.id} business={focused} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionBody({ id, business }: { id: SectionId; business?: Business }) {
  if (id.startsWith('biz:')) {
    if (!business) return <p className="text-sm text-slate-500">Pick a business first.</p>;
    if (id === 'biz:modules') return <ModulesPanel business={business} />;
    return <BusinessSettingsPanel business={business} only={id.slice(4) as BusinessSection} />;
  }
  switch (id) {
    case 'profile': return <ProfilePanel />;
    case 'appearance': return <AppearancePanel />;
    case 'account': return <AccountPanel />;
    case 'account-brand': return <BrandingPanel />;
    case 'people': return <PeoplePanel />;
    case 'teams': return <TeamsPanel />;
    case 'payments': return <PaymentsPanel />;
    case 'automation': return <AutomationPanel />;
    case 'labels': return <LabelsPanel />;
    case 'tokens': return <TokensPanel />;
    case 'notes': return <NotesPanel />;
    default: return null;
  }
}
