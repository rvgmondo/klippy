# The organisation model, and the Work tab

Researched and designed 2026-09-03 by a 10-agent workflow: three research agents (CRM
vendors, PSA tools, party-model theory), three rival designs from different starting
biases, three judges, one synthesis. Proposals were **One Org Row**, **Party Core** and
**The Directory Split**.

NOTHING HERE IS BUILT YET. This is the plan, not the state of the code.


## Recommendation

SPINE: Proposal 3, the Directory Split. One `organisations` table lifted out of `folders`, relationship type on a join table, `folders` demoted to a pure work tree with a nullable `organisation_id`, and a real organisation record page. It won the usability judge outright and scored second on model correctness, and it is the only one of the three that a solo founder with live billing will actually finish.

GRAFTED IN, from the judges' keep-lists:
- P1's guarded contract migration written in the same PR as the expand migration, plus a startup assertion (all three judges named this).
- P1's refusal to move `hourlyRate` and `monthlyHoursBudget` off `folders` (two judges).
- P2's `source` column inside the role table's UNIQUE key, plus `since`/`until` dates.
- P2's `expenses.supplier_organisation_id` named distinctly and deliberately NEVER backfilled (this is the fix for a real corruption bug in both P1 and P3).
- P2's phase-0 export/import lockstep and the rate-equivalence gate.
- P3's id-preservation trick, demoted from a semantic guarantee to a one-time backfill mechanic with an explicit provenance column beside it.
- P3's read-only pre-flight audit before any DDL.
- P3's zero-count role chips and role-dependent Money tab with a net-position line.

TWO CORRECTIONS TO ALL THREE PROPOSALS, from reading the code:

1. The portal JWT panic is overstated. `api/src/lib/portalAuth.ts:127` reads `payload.pid`, re-queries `portal_users`, and takes `folderId` FROM THE ROW. The token's `fid` is used only in the PREVIEW branch (line 120, fed by `signPreviewToken` at `routes/portal.ts:845`). So live client sessions do not break on a column repoint. Only the staff preview token needs dual-accept, and it has a short TTL.

2. `storage_nodes` (schema.ts:610) has NO folder, client or task link at all. It is a standalone tree with `parentId` and nothing else. Every proposal promised a Files tab on the organisation record page "reusing FilesSection scoped through the org's folders". That is not buildable without new columns. The Files tab is cut from v1 and listed as deferred work.

SIZE: 3 new tables, 9 nullable columns, 2 new `accounts` columns, 1 new `folders` boolean. Zero columns dropped until the final guarded phase. Six phases, each shippable alone.


## Why roles are a join table, not a type column

A JOIN TABLE (`organisation_roles`), multi-valued from day one, with `source` inside the unique key. Not an enum column on `organisations`, not a JSON tag set.

=== Against a single `type` enum on the organisation row ===

Four of the seven CRMs studied shipped this, hit the wall, and paid in public with a dated migration. Pipedrive broke its own API: `label` went from integer to comma-separated string and `dealFields.field_type` went from `enum` to `set`, announced November 2022, effective January 2023, delayed, rolled out March 2023, changed shape again to a proper array in v2. HubSpot opted every existing portal into multi-label associations in April 2022 and documented that a portal cannot be opted back out. Salesforce replaced AccountContactRole with AccountContactRelation in 2016. Nobody has ever moved in the other direction.

The tell is visible in Salesforce's default picklist to this day: `Customer - Direct`, `Customer - Channel`. That is a single-valued field trying to encode two dimensions. If a proposed enum starts growing hyphenated compound values, the model is wrong. Klippy has no such column yet, which is the entire opportunity. Retrofitting multi-value onto a single-value column is the most expensive schema change in this space and it is avoidable by not making the mistake.

=== Against a JSON tag set on `organisations` ===

This is settled by the engine, not by taste. The array-versus-junction benchmark from the research (roughly 120ms against roughly 950ms, about 7x) is a PostgreSQL `int[]` with a GIN index. Klippy runs MariaDB (`scripts/dev-db.ps1`, cPanel likewise). MariaDB has no array type, no GIN, and no multi-valued indexes. A roles tag column here means `FIND_IN_SET(...)` or `JSON_CONTAINS(...)` in the WHERE clause, both unindexable full table scans on every "show me all suppliers" filter, and the Directory screen runs one such count per role chip on every load. The junction table is not the expensive option in this environment, it is the cheap one.

The integrity case then stands on its own: neither MariaDB nor Postgres can declare a foreign key on array elements, so orphaned role values accumulate silently and the relationship is invisible in the ERD.

=== Why `source` must be a column, and inside the unique key ===

This is the highest-value column in the design and it is the reason a tag set cannot work even if performance were free.

Straight from Xero: `IsCustomer` and `IsSupplier` are not asserted by a human, they are set when an AR or AP transaction appears. The flag cannot disagree with the ledger and nobody can forget to tick a box. Klippy can derive nearly everything:

- `customer` derived when the org has any non-draft document, any subscription, or any deal at `stage='won'`. `firstAt = MIN(issue_date)`.
- `supplier` derived when the org is named on any expense via `supplier_organisation_id`.
- `lifecycle='prospect'` when there are no derived roles and at least one deal not in (won, lost).
- `lifecycle='active'` on any document, subscription or time entry in the last 90 days; `dormant` after 180 with nothing; `archived` is manual only, never automatic.

But a human must still be able to say "this is a partner" about an org with no transactions. Those two facts have to coexist and be distinguishable, or the nightly recompute stomps the assertion. `source` in the UNIQUE key `(organisation_id, role, source)` means a derived row and a manual row for the same role are two rows, neither can overwrite the other, and the reconciler's WHERE clause carries `source='derived'`. **That predicate gets its own test.** A missing predicate there silently deletes every hand-set partner tag in the account.

In the UI a derived chip shows a small ledger icon with a tooltip ("from 4 invoices") and cannot be removed by hand. You remove the transactions or you archive.

=== Why `firstAt` / `lastAt` / `endedAt` ===

"Customer since March 2024", "churned in November", "ex-supplier, kept not deleted". Salesforce's AccountContactRelation is the only vendor object in the research that carries multi-valued role PLUS validity dates PLUS an active flag, and it is the one that ages best. All three are impossible on a boolean flag and require JSON gymnastics on an array. `endedAt` also means a role is a state change rather than a DELETE, so history survives.

=== LIFECYCLE is separate and is correctly one column ===

`organisations.lifecycle` (prospect | active | dormant | archived) is ordered, mutually exclusive, and a state machine. Conflating it with role is the specific defect that makes HubSpot's Lifecycle Stage the main source of data degradation in unmanaged portals. Roles say what we are to each other; lifecycle says how warm it is. An org can be `dormant` and still hold `supplier`. A `prospect` chip in the Directory filters on lifecycle, and the UI shows it in a separate row from the role chips so that nobody ever invents a "Client/Prospect" compound value.

=== The person-to-organisation axis: junction NOT BUILT ===

`contacts.organisation_id` is a single nullable FK, the denormalised primary link, full stop. No `contact_organisations` table.

The research is the argument FOR this, not against it. Salesforce built the junction and pays for it permanently: standard account-contact report types exclude related contacts entirely so an org must hand-build three custom report types before it can report at all; Pardot honours only the primary relationship; in private-sharing orgs users cannot see related contacts; mass updates need Data Loader. And Salesforce still kept `Contact.AccountId` as the single direct link driving the common path. A vendor with unlimited budget concluded the denormalised primary beats a pure many-to-many.

The owner's actual complaint is entirely on the organisation axis. "Some contacts can be clients some can be referrals some can be partnerships and agencies" is Axis A, and `organisation_roles` answers it completely. Klippy's customers are South African small businesses where a large share of counterparties are sole traders, and the junction is pure overhead on every contact list query. The honest test: if nobody asks "all companies for this person", the junction buys correctness that is not being used.

The footprint is left, which is PayPal's actual advice rather than the maximalist reading of it. `organisations.id` is a stable surrogate that exists from day one. Adding `contact_organisations (accountId, contactId, organisationId, role, isPrimary, fromDate, thruDate)` later is a pure additive migration with a trivial backfill from `contacts.organisation_id`. The expensive thing to retrofit is the identity, and the identity is what is being built now.


## Can a non-client hold work

YES, three ways, and this is deliberate. Klippy takes the Productive and Scoro shape (nullable FK plus an explicit type), not the Accelo, Teamwork and Harvest shape (mandatory FK).

The rejected pattern matters. Accelo's own documentation says all work must be logged "Against a singular Company", and its own remedy for internal work is that you create a company record for yourself: "Many of our clients create an Internal Client to do just that." Harvest requires `client_id` on project creation. Teamwork tells you to pick your own company. Every report in those systems then filters your own company out by name, and it gets worse the moment partners and suppliers also hold work. Productive made `company_id` optional and added `project_type_id` (1 internal, 2 client); Scoro has `project_type` regular/retainer/internal.

Klippy gets that shape for two columns, and it already half-ships it: `folders.pillar='operations'` folders seeded by `lib/seed.ts:67` are exactly the internal case, they just have no name for what they are.

=== The three cases ===

1. NOBODY'S WORK. `organisation_id IS NULL`, `pillar='operations'`, `is_billable=false`. Today's Operations tree, untouched. "Store floor", "Marketing", "The product itself". Boards, tasks and time all work identically. There is structurally no rate to resolve and no invoice path, so internal hours cannot leak onto a client invoice. This is Scoro's rule adopted wholesale, and it is enforced on write in `routes/folders.ts`, not just documented.

2. A NON-CLIENT COUNTERPARTY'S WORK. `organisation_id` set, `pillar='delivery'`, on an org whose only role is `supplier` or `partner`. Onboarding a supplier, a partner integration, a joint venture, pro-bono work. Time logged there rolls up to that org in reports as HOURS SPENT under a cost-of-relationship heading, not a revenue line, because no rate resolves. **This case is completely unrepresentable today**: it has to be faked as either a client folder or an operations folder, and both are lies. It costs zero extra schema.

3. A PROSPECT'S WORK. An org at `lifecycle='prospect'` with no roles holding a folder: pitch prep, a spec doc, a trial build. When the deal is won the lifecycle flips and the role appears. The folder does not move and does not change id. Nothing converts.

=== Why not add a `work_type` enum ===

Judge 1 wanted P2's `work_type enum('client','internal','other')`, arguing correctly that a single nullable `organisation_id` is being asked to mean three things at once: internal work, client work not yet linked, and client work whose org got SET NULL on delete.

Resolved with invariants rather than a column, because `pillar` already exists and is already read in six files:
- Internal is `pillar='operations'`, which is enforced to imply `organisation_id IS NULL`.
- The 'other' case is "org set, org has no `customer` role", which is derivable and needs no third enum value.
- "Client work not yet linked" is `parentId IS NULL AND pillar='delivery' AND organisation_id IS NULL`, which is exactly the reconciliation screen's query, and which is empty by construction after phase 5 because the New Folder flow requires an org.
- "Org deleted to NULL" cannot happen for a live org: the org record page refuses to delete an org that holds a folder, a subscription or an unpaid document, and offers archive instead. `SET NULL` is the FK's last-resort behaviour, not a normal path.

That closes all three meanings without renaming `pillar` across `dashboard.ts:37`, `seed.ts:67`, `handoff.ts:61`, `account.ts`, `search.ts:54` and `Sidebar.tsx:312`.

=== Where the billable path runs ===

Klippy runs the parent-chain model (time entry -> task -> board -> folder -> walk to root -> the client), same as Harvest, Teamwork, Scoro and Accelo. It is kept. Productive's service/budget spine earns its keep only when one project bills across several budgets or one budget spans projects, and adding a services and budgets layer is the largest rewrite available here.

The one change: `routes/reports.ts:61` `rootOf()` still walks to the root, but the per-client rollup keys on `root.organisationId` instead of `root.id`. Two folders for the same client finally collapse into one line. That is a real bug fix that falls out of the migration, and it changes numbers on a screen the owner reads weekly, so it ships with a note rather than silently.

`time_entries` and `tasks` gain nothing. An `organisationId` cached on a time entry would go stale the moment a board is moved between folders, and moving a board between folders is a supported operation that must re-attribute its time.


## The entity model

All names verified against `api/src/db/schema.ts`. Next migration number is 0069 (journal ends at idx 68). Engine is MariaDB (`scripts/dev-db.ps1:10`, portable MariaDB; mysql2 driver, `api/package.json:32`). Hand-written SQL migrations are already the norm (e.g. `drizzle/0014_add_expense_folder.sql`).

=== NEW TABLE 1: organisations ===

The single counterparty identity. Every FK anywhere that means "who are we dealing with" points here and nowhere else.

```ts
export const organisations = mysqlTable('organisations', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  // NULL = shared across every business in the workspace (a landlord, an accountant,
  // a bank the agency and the shop both use). businessScope() in lib/access.ts already
  // handles a nullable businessId on contacts and calendar_events.
  businessId: int('business_id', { unsigned: true })
    .references(() => businesses.id, { onDelete: 'cascade' }),

  name: varchar('name', { length: 150 }).notNull(),

  // LIFECYCLE. Single-valued and ordered ON PURPOSE. This is the one axis where one
  // column is correct. Never put 'client' or 'supplier' in here.
  lifecycle: mysqlEnum('lifecycle', ['prospect', 'active', 'dormant', 'archived'])
    .default('active').notNull(),

  // The designated primary. Every vendor that went many-to-many kept one.
  primaryContactId: int('primary_contact_id', { unsigned: true }),  // FK added in phase 2, SET NULL

  // Billing identity, copied from folders. Same column names, so the backfill is a copy.
  billingEmail: varchar('billing_email', { length: 150 }),
  billingPhone: varchar('billing_phone', { length: 40 }),
  billingAddress: text('billing_address'),
  billingVatNumber: varchar('billing_vat_number', { length: 60 }),
  billingRegNumber: varchar('billing_reg_number', { length: 60 }),  // new; today it gets typed into the address

  // NULL = inherit the business currency. Advisory only: the DOCUMENT currency still
  // comes from currencyFor(accountId, businessId). Money is never converted.
  currency: varchar('currency', { length: 3 }),

  // The LAST fallback in rate resolution, NULL for every migrated row so day-one
  // numbers are byte-identical. See "rate resolution" below.
  hourlyRate: decimal('hourly_rate', { precision: 10, scale: 2 }),

  website: varchar('website', { length: 190 }),
  source: varchar('source', { length: 60 }),   // where they came from; survives the deal
  color: varchar('color', { length: 20 }).default('#6366f1').notNull(),
  imagePath: varchar('image_path', { length: 255 }),
  notes: text('notes'),

  // PROVENANCE. The explicit form of the id-preservation trick. Any code that needs
  // "the org that came from folder X" reads THIS, never `org.id === folder.id`.
  legacyFolderId: int('legacy_folder_id', { unsigned: true }),
  legacyCompanyText: varchar('legacy_company_text', { length: 190 }),  // the free-text string it was resolved from

  isArchived: boolean('is_archived').default(false).notNull(),
  deletedAt: datetime('deleted_at'),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_orgs_account_business').on(t.accountId, t.businessId, t.name),
  index('idx_orgs_account_lifecycle').on(t.accountId, t.lifecycle),
  index('idx_orgs_legacy_folder').on(t.legacyFolderId),
]);
```

NO `kind` enum ('company' | 'person'). This is the deliberate resolution of Judge 1's fatal against P1 and P3. See judgeDisagreements.

NO `email` or `phone` columns. Only `billingEmail` and `billingPhone`. A human's personal email and phone live on `contacts` and nowhere else, so there is no column that can drift between the two tables.

NO unique index on `name`. QuickBooks Online enforces name uniqueness and its own official remedy is to rename a record to "Paul Santos 1". Duplicates are a review problem, not a constraint problem.

=== NEW TABLE 2: organisation_roles ===

What this organisation is TO US. Multi-valued, on a link, with provenance and dates.

```ts
export const organisationRoles = mysqlTable('organisation_roles', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  organisationId: int('organisation_id', { unsigned: true }).notNull()
    .references(() => organisations.id, { onDelete: 'cascade' }),
  // varchar, NOT a MySQL enum. Adding a role must never be an ALTER TABLE.
  // Vocabulary lives in api/src/lib/orgRoles.ts and varies by business type.
  role: varchar('role', { length: 32 }).notNull(),
  // 'derived' = the app worked it out from the ledger. 'manual' = a human said so.
  // IN THE UNIQUE KEY, so both can coexist for the same role and the nightly
  // reconciler can only ever touch its own rows.
  source: mysqlEnum('source', ['derived', 'manual']).default('derived').notNull(),
  firstAt: datetime('first_at'),   // "customer since"
  lastAt: datetime('last_at'),     // last transaction in this role
  endedAt: datetime('ended_at'),   // ex-supplier, kept rather than deleted
  note: varchar('note', { length: 200 }),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('uniq_org_role').on(t.organisationId, t.role, t.source),
  index('idx_org_roles_lookup').on(t.accountId, t.role, t.organisationId),
]);
```

=== NEW TABLE 3: organisation_merges ===

```ts
export const organisationMerges = mysqlTable('organisation_merges', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  survivingId: int('surviving_id', { unsigned: true }).notNull(),
  mergedId: int('merged_id', { unsigned: true }).notNull(),
  // The full pre-merge row plus every repointed id, enough to unwind by hand.
  payload: json('payload').$type<Record<string, unknown>>().notNull(),
  mergedAt: datetime('merged_at').notNull(),
  mergedBy: int('merged_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
});
```

Merging is a HARD merge (rows repointed, loser deleted) with this snapshot as the undo. Rejecting P2's soft merge via `merged_into_id`: a tombstone that every read path across 33 files must remember to follow renders a real-looking company with zero invoices when one path forgets, and that is indistinguishable from a quiet client.

=== COLUMNS ADDED TO EXISTING TABLES ===

All nullable, all `ON DELETE SET NULL` unless stated.

| Table | Column | Meaning and note |
|---|---|---|
| `accounts` | `org_label_singular` varchar(40) default 'Client' | NEW columns, NOT a repurpose of `folder_label_singular`. See judgeDisagreements. |
| `accounts` | `org_label_plural` varchar(40) default 'Clients' | Seeded from the existing folder labels at migration time. |
| `folders` | `organisation_id` | **MUST be SET NULL, never CASCADE.** A CASCADE here means deleting an org from the new Directory destroys that client's board tree and every tracked hour. This is the single most dangerous keyword in the whole migration. |
| `folders` | `is_billable` boolean default true notNull | Enforced invariant: `pillar='operations'` implies `organisation_id IS NULL` and `is_billable = false`. Scoro's internal-project rule. |
| `contacts` | `organisation_id` | The denormalised PRIMARY link. `company` free text stays as the fallback. `folder_id` stays until the final phase. |
| `deals` | `organisation_id` | `clientFolderId` KEPT under its existing name (no rename: it is read in `lib/handoff.ts`, `lib/export.ts:65`, `lib/importAccount.ts:377`). `company`/`contactName`/`contactEmail`/`contactPhone` stay as the napkin-lead fallback. |
| `documents` | `organisation_id` | Who is billed. `folder_id` KEPT and re-meaned as "which project this bills for". Harvest's client-level grain plus Scoro's project column. |
| `subscriptions` | `organisation_id` | Becomes NOT NULL with **FK RESTRICT** in phase 5. `folder_id` relaxed from `notNull` CASCADE to nullable SET NULL and KEPT (it answers "which work does this retainer fund", which the monthly-hours comparison wants). |
| `portal_users` | `organisation_id` | Becomes NOT NULL in phase 5; unique index moves from `(folder_id, email)` to `(organisation_id, email)`. `folder_id` relaxed to nullable SET NULL. |
| `expenses` | `supplier_organisation_id` | **Deliberately distinct name. NEVER backfilled. Left NULL at migration.** `folder_id` keeps its existing job (which client's project this cost belongs to, `routes/reports.ts:132`). |
| `recurring_expenses` | `supplier_organisation_id` | Same. |
| `calendar_events` | `organisation_id` | "The client this is with" (the existing comment at schema.ts:290 is literally describing an org link with nowhere to go). `folder_id` stays. |

`hosting_accounts`: **zero change.** It reaches the org through `subscription_id` (unique, SET NULL). The `liveHostingForFolders` guard in `lib/hosting.ts:896` walks folder ids and keeps working because folders still exist.

`sales` (counter takings): **zero change, permanently.** A card-machine tap on a walk-in has no counterparty and must never be forced to invent one.

`storage_nodes`: **zero change.** It has no client link today and giving it one is out of scope. The org record page has no Files tab in v1.

=== RATE RESOLUTION (unchanged on day one, by construction) ===

`folders.hourlyRate` and `folders.monthlyHoursBudget` STAY on `folders`. Two implementations of the nearest-ancestor walk exist today and they differ slightly: `routes/reports.ts:66` (`rateFor`) and `routes/documents.ts:1116` (inline, inside `/documents/from-time`). Neither is touched. The only change is one appended step:

`rateFor(folderId)` = nearest self-or-ancestor `folders.hourly_rate`, THEN `organisations.hourly_rate` of the root's org, THEN null.

Because `organisations.hourly_rate` is NULL for every migrated row, the function returns identical numbers on the day it ships. The org rate is new capability for an org with no folder, not a relocation of an existing one. Both walks are collapsed into one shared helper `api/src/lib/directory.ts` only after the equivalence gate in phase 5 passes.

=== NEW LIB: api/src/lib/orgRoles.ts ===

```ts
export const ROLE_SUGGESTIONS: Record<BusinessType, string[]> = {
  services: ['customer', 'supplier', 'partner', 'referrer'],
  products: ['supplier', 'wholesale', 'consignor'],
  code:     ['customer', 'supplier', 'reseller', 'partner'],
  content:  ['customer', 'supplier', 'publisher', 'referrer'],
};
export const DERIVED_ROLES = ['customer', 'supplier'] as const;
```

=== NEW LIB: api/src/lib/directory.ts ===

- `orgOf(folderId)` : root folder's `organisation_id`, using the same 100-iteration guarded walk as `routes/reports.ts:61`.
- `rateFor(folderId)` : the three-step chain above.
- `syncDerivedRoles(accountId)` : the nightly reconciler, added to `lib/jobs.ts`.
- `mergeOrganisations(survivingId, mergedId)` : the only writer of `organisation_merges`.


## What happens to folders, contacts and deals

=== folders (schema.ts:311) : SURVIVES, demoted to one job ===

KEEPS, untouched: `id`, `accountId`, `businessId`, `parentId`, `name`, `color`, `notes`, `imagePath`, `pillar`, `position`, `isArchived`, `deletedAt`, `createdBy`, timestamps. The cascade on `parentId` is unchanged. `boards.folderId NOT NULL` is unchanged. `subtreeIdsFrom` in `lib/folderTree.ts` is unchanged. Not one line of the boards, tasks or timer code changes.

KEEPS, re-meaned: `hourlyRate` demotes from "the client's rate" to "the rate for this piece of work", `monthlyHoursBudget` stays as "this folder's retainer allowance". Both keep working exactly as they do now.

GAINS: `organisation_id` (nullable, SET NULL) and `is_billable` (boolean, default true).

LOSES, in the final guarded phase only: `billing_email`, `billing_phone`, `billing_vat_number`, `billing_address`. Not dropped, moved: `CREATE TABLE folders_billing_archive AS SELECT ...` first, kept indefinitely, added to the export.

`pillar` STAYS as it is, with a constraint behind it for the first time. It is read in `routes/dashboard.ts:37` (`rootPillar`), `routes/account.ts`, `lib/seed.ts:67`, `lib/handoff.ts:61`, `routes/search.ts:54` and `web/src/components/Sidebar.tsx:312`. Renaming it to `work_type` is pure churn across six files for zero user-visible gain. New invariant, enforced on write in `routes/folders.ts`: `pillar='operations'` implies `organisation_id IS NULL` and `is_billable=false`.

The rule that replaces "a top-level folder IS a client":

> A top-level folder with `organisation_id` set is work for that organisation. A top-level folder with `organisation_id` NULL and `pillar='operations'` is internal work. After phase 5 nothing else is reachable, because the New Folder flow requires an org for a delivery-pillar root when the `clientwork` module is on.

What `folders.name` becomes: for an org-bearing root folder the tree renders `organisation.name`, and `folders.name` is kept in sync by the one writer. `folders.name` stays `NOT NULL` because subfolders need it. This is an honest permanent wart and it is cheaper than the alternative.

=== contacts (schema.ts:1493) : SURVIVES INTACT, gains a real link ===

Not renamed. Not viewed. Not absorbed. This is a direct rejection of P2's `contacts_legacy` plus a MySQL VIEW, which Judge 2 correctly identified as unshippable: `routes/crm.ts:71`, `:99` and `:117` do a direct INSERT, UPDATE and DELETE against the `contacts` Drizzle object, and a view over `organisations` whose `company` column derives from a join is not insertable, updatable or deletable in MariaDB. Contact CRUD would break on release day.

GAINS: `organisation_id` (nullable, SET NULL). This is the primary and only person-to-org link.
KEEPS: `company` free text, as the fallback for an unlinked import and for a contact whose employer is not a record yet. Shown in grey in the UI with a "link" affordance.
KEEPS: `role` varchar(80) as the job title. This is Axis B and it stays deliberately thin.
LOSES, final phase only: `folder_id`, after `organisation_id` is backfilled from it.

`contacts.businessId` is already nullable, so the businessScope handling that `organisations.businessId` needs already exists and is already proven.

=== deals (schema.ts:1436) : SURVIVES, gains a link, loses nothing ===

GAINS: `organisation_id` (nullable, SET NULL).
KEEPS, permanently: `company`, `contactName`, `contactEmail`, `contactPhone`. The schema comment at line 1452 already argues for this and it is right. A lead scribbled at 11pm must take four seconds to enter.
KEEPS its name: `clientFolderId`. No rename. It means "the work folder the Golden Handoff created" and it is the idempotency guard in `lib/handoff.ts` (`if (deal.clientFolderId) return ...`). Renaming it touches handoff.ts, deals.ts, export.ts:65 and importAccount.ts:377 for cosmetics.
GAINS a real FK on `contactId`, which today is a bare int with no `.references()` (schema.ts:1459). Added with SET NULL in phase 1. If the FK creation fails there are orphaned contact ids in production, which is worth finding out.

The conversion path, finally continuous:

Today: deal (free-text company) -> won -> `handoff.ts` creates a top-level folder named `deal.company || deal.title`. The company name becomes a folder name and the trail ends. There is no key shared between the deal and the invoice.

After: organisation exists from the moment the lead is more than a name -> `deals.organisation_id` -> won -> the handoff reads `deal.organisationId` instead of inventing a name -> creates the folder with `organisation_id` set -> the draft invoice carries `documents.organisation_id`. `handoff.ts` gains four lines at the top of `create-client-workspace` and stays idempotent because `clientFolderId` is still the guard. Lead-to-cash reporting is possible for the first time.


## The screens

Two screens change. Everything else gains a working link.

=== 1. WORK TAB (`AREAS` key `work`, Sidebar.tsx:47) ===

Tabs unchanged: Today | Board | Calendar | Reports | Files.

The sidebar tree (`Sidebar.tsx:221`) stops being titled "{Clients} and boards" and becomes "Work". Two sections, whose labels are now checkable facts rather than a naming convention:

```
ACME AGENCY
  CLIENT WORK              <- root folders with organisation_id set
    [logo] Vodacom
             Retainer
             Website rebuild
    [logo] Ashford Legal
  INTERNAL                 <- root folders with organisation_id NULL
    Operations
    Marketing
```

This replaces the existing "Delivery / {Clients}" and "Operations / Internal" headers at `Sidebar.tsx:312` and `:320`, which are the same idea driven by `pillar` with no record behind them. `pillar` still drives it underneath; the difference is that the client rows now render the ORG's `imagePath` and `color` and `name`, and clicking the group row opens a real page.

NEW on every board header: an ORG CHIP (colour dot plus name), clickable. Today `BoardView.tsx:290` opens the `ClientTimeline` drawer; that drawer becomes the Activity tab of the record page, and its endpoint `/folders/:id/timeline` becomes `/organisations/:id/timeline` with the same body. An internal folder shows no chip: nothing to click, nothing missing.

NEW: a flat Work overview list, which does not exist today at all. Every folder as a row: Name, Client (org chip, or "Internal"), Boards, Open tasks, Overdue, Hours this month, Unbilled hours, Last activity. Sortable and filterable by org, by business, by client/internal. Today the only way to see work is to navigate a tree, so "what is unbilled across everything" needs a report.

=== 2. DIRECTORY (new view key `directory`, lives in the Sales area) ===

It goes in Sales, alongside Pipeline and Offerings, and `ContactsView.tsx` is absorbed into it as a sub-tab. Sales is where relationships live; Work is where work lives.

Add `'directory'` to `AREAS[sales].views` in `Sidebar.tsx:53` and to the tab push in `PageHeader.tsx:56`, and to `CommandPalette.tsx:82`.

ONE LIST. Not a Customers page and a Suppliers page: that is Zoho's split, which forces two records for one company and whose own supported remedy is a destructive conversion that deletes the original.

Header, role filter chips with live counts from `organisation_roles`, **rendered only when count > 0**:

```
All 47 - Customers 31 - Suppliers 9 - Partners 4 - Referrers 3
```

A retailer therefore reads `All 14 - Suppliers 14` and never encounters the word "customer" anywhere in the product. No module conditionals sprinkled through the list view, no empty tabs, and switching a module on later reveals a chip rather than needing a migration. Chips are OR-filters, multi-select, backed by `EXISTS (SELECT 1 FROM organisation_roles WHERE organisation_id = organisations.id AND role = ?)` against `idx_org_roles_lookup`.

A SEPARATE second row for lifecycle: `Prospect | Active | Dormant | Archived`, plus a business filter when the workspace has more than one, plus search. Keeping lifecycle visually separate from roles is what stops anyone ever inventing a compound value.

Sub-tabs: **Companies | People**. People is `ContactsView.tsx`, near-intact, with the free-text `company` field replaced by an org picker that offers "create company: Foo" inline. Contacts with no org still save and still show their grey free-text company with a link affordance. Nobody is forced to tidy anything.

Columns: Name (logo/colour) - Roles (chips, derived ones dimmed with a ledger icon) - Open work (folder count) - Owing (in that org's currency, never converted) - Last activity.
DEFAULT SORT: Owing descending. The question a founder opens this screen to answer is "who owes me". Sorting by name answers nothing.
Row hover actions: New invoice - New work folder - Log activity.

=== 3. ORGANISATION RECORD PAGE (the thing Klippy has never had) ===

HEADER: logo/colour, name, EDITABLE ROLE CHIPS (multi-select; adding writes a `source='manual'` row; a derived chip is not hand-removable), lifecycle pill, primary contact with click-to-call and click-to-WhatsApp (`lib/messaging.ts` already has `phoneForClient`), currency, and three buttons: New invoice - New work folder - Log activity.

OVERVIEW STRIP, always visible: Owing now - Billed this year - Open work - Hours this month against `monthlyHoursBudget` - Next follow-up - Last activity.

TABS, each rendered only when its module is on and it has content:

- **Activity** : the merged feed (documents, `deal_activities` through `deals.organisation_id`, time, portal logins). `ClientTimeline.tsx` promoted from a drawer. It immediately gets richer, because it now spans the pre-sale period the folder never had.
- **Work** : this org's folders and boards, hours logged, current rate and where it resolved from.
- **Money** : ROLE-DEPENDENT. This is the payoff screen.
  - `customer` role -> Invoices - Quotes - Subscriptions - Payments - Statement - Collections status. Reuses `BillingView.tsx` and `StatementView.tsx`.
  - `supplier` role -> Bills and expenses (`expenses` where `supplier_organisation_id` = this org) - Recurring costs - Total paid this year.
  - BOTH -> both sections stacked on ONE record, with a net position line at the top: **"You owe R12,400 - They owe R31,900"**. That single line is structurally impossible in QuickBooks and Zoho without two records, and it turns an abstract schema argument into something the owner can see in four seconds.
- **People** : contacts with this `organisation_id`, primary flagged, "+ add person" prefills the org.
- **Deals** : deals with this `organisation_id`, open and closed, with `lostReason`.
- **Portal** : `portal_users` for this org, invite link, last login. Reuses `PortalAccessModal.tsx`.
- ~~Files~~ : **CUT from v1.** `storage_nodes` (schema.ts:610) has no client, folder or task link. Every proposal promised this tab and none of them can build it. Deferred; would need `storage_nodes.organisation_id`.

=== 4. PROSPECT BECOMES CLIENT: NO CONVERSION ===

A deal is created against an org. The picker searches existing orgs and offers "create new" inline; a new one is born `lifecycle='prospect'` with zero roles. Free-text `company` still works and stays a string until someone links it.

Dragging to WON opens ONE dialog with three options (Productive's four, trimmed):
- Create a work folder for this (name pre-filled from the deal title, becomes a root folder with `organisation_id` set)
- Add to an existing folder (picker of that org's folders)
- Just mark it won (invoice-only work, no folder)

Then: lifecycle `prospect` -> `active`, `organisation_roles` gains `customer` (`source='derived'`, `firstAt=now`), `deals.wonAt` and `clientFolderId` set. **The organisation id does not change.** Call history, notes, contacts and email survive intact, because nothing was converted: a role was added.

=== 5. THINGS THAT GET SMALLER, NOT BIGGER ===

- `ContactsView.tsx` -> the People sub-tab. Same component, new data source, plus role context.
- `ClientTimeline.tsx` drawer -> the Activity tab.
- `NewClientModal.tsx` -> creates an ORGANISATION with the `customer` role and OPTIONALLY a first folder. The two are decoupled, which is the point: a client with no work now has a home.
- `ClientPicker.tsx` -> picks an org, not a folder. Used by quotes, invoices, subscriptions, portal access and calendar events, several of which today pick a folder and mean a client.
- `routes/search.ts:52` currently special-cases `isNull(folders.parentId)` to surface clients. It becomes a search over `organisations.name` and `billing_vat_number`, which is strictly better: suppliers and prospects become findable, and today they are invisible to search because they are free text on rows nobody indexes.


## Retailer versus agency, through modules

The tables are IDENTICAL for every business type. Only the chips offered, the tabs rendered and the noun differ. That is the whole point of putting the type on the link: a retailer and an agency are the same schema wearing different words, and switching a module on later reveals a tab rather than requiring a migration.

=== TWO NEW KEYS in api/src/lib/modules.ts ===

```ts
// Acquisition
{ key: 'directory', label: 'Directory', primitive: 'acquisition',
  hint: 'Everyone this business deals with.' },
  // No defaultFor, so EVERY business type gets it. Every business deals with
  // somebody, even if it is only a landlord and a wholesaler. It is also the
  // destination of every org chip in the app, so it must never be missing.

// Fulfillment
{ key: 'clientwork', label: 'Client work', primitive: 'fulfillment',
  defaultFor: ['services', 'code', 'content'],
  hint: 'Work filed under the company it is for.' },
```

`effectiveModules()` and `defaultModulesFor()` need no change: a def with no `defaultFor` is already on for everyone (modules.ts:76), and `clientwork` with `defaultFor` is already off for `products`.

`directory` is NOT marked `core: true`. It does not need to be: with no `defaultFor` it is on by default and the owner can still switch it off, unlike Billing.

=== WHEN `clientwork` IS OFF, three things happen and nothing else breaks ===

1. The Work sidebar drops the CLIENT WORK section. Every folder is internal, the tree is a flat list of areas, and it looks exactly like the tool a shop wants.
2. The New Folder flow never asks for an organisation and never requires one. `NewClientModal.tsx`, which today demands a billing email, VAT number and hourly rate, is not reachable.
3. Boards render no org chip. Reports drops the per-client table and shows hours by person and by area. `unratedClients` in `ReportsView.tsx:166` disappears, which is correct: there is no such thing.

And one derived-data rule, which matters more than it looks: **`syncDerivedRoles()` only writes roles that the business's modules allow.** A retailer with `clientwork` off never gets a `customer` role written by a stray invoice, so their Directory never quietly grows a Customers chip they did not ask for. Without this the clean product decays back into an agency tool on its own.

=== THE RETAILER (`businesses.type='products'`), a vape shop ===

Modules on: today, calendar, billing, takings, expenses, directory, files.
Modules off: clientwork, pipeline, reports, collections, portal, offerings.
Noun: `accounts.org_label_plural` = "Suppliers" (seeded from type at migration).
Role vocabulary offered: `['supplier', 'wholesale', 'consignor']`. `customer` is not offered, because a walk-in buyer is a counter sale, not a record.

Directory: one list, chips read `All 14 - Suppliers 14`. Columns become Name - Roles - Owed to them - Last purchase.
Org record page tabs: Activity - Money (bills and expenses, recurring costs) - People - Notes. No Work tab, no Deals tab, no Portal tab, no invoices, no hourly rate.
Money: Takings (`sales`, already `defaultFor: ['products']`) for revenue, Expenses with a supplier picker for cost. **Counter sales never touch the Directory.** `sales` gains no column, ever.
Invoicing still works with no org at all: `documents.clientName` is NOT NULL and snapshotted, `organisation_id` is nullable. A shop raising an occasional trade invoice types a name and never opens the Directory. The Directory must not become a toll gate on a one-off invoice.

**The word "client" appears nowhere in this product.**

The retailer's mental model is: Directory is my supplier list. One screen, correctly named, doing an obviously useful job. That is the test the current app fails outright, because today a supplier can only exist as a free-text string in the description of an expense.

=== THE AGENCY (`type='services'`), twenty clients ===

Modules on: everything above plus clientwork, pipeline, reports, collections, cashflow, offerings, portal.
Noun: "Clients".
Role vocabulary: `['customer', 'supplier', 'partner', 'referrer']`.
Chips: `All 47 - Customers 31 - Suppliers 9 - Partners 4 - Referrers 3` plus a lifecycle row with Prospects.
Full record page, full Work tab, portal logins, retainer hours against budget.

The case that only works now: a design studio the agency subcontracts to, who also refers work back. ONE org, roles `['supplier', 'referrer']`, with expenses paid to them on the Money tab and referred deals on the Deals tab. Today that is two free-text strings in two tables that will never be connected.

=== THE DEALERSHIP (`type='products'` with `secondaryTypes=['services']`) ===

`clientwork` ON, `takings` ON, `portal` ON. Noun: "Companies". Full role vocabulary.
Chips: `All 88 - Customers 61 - Suppliers 22 - Partners 5`, with eleven organisations carrying BOTH `customer` and `supplier`. One record each, one contact list each, one net-position line each. This is the case Zoho needs two separate modules and a destructive conversion to approximate.

=== THE VOCABULARY MECHANISM ===

TWO NEW COLUMNS on `accounts`: `org_label_singular` and `org_label_plural`, seeded at migration from the existing `folder_label_singular` / `folder_label_plural`, defaulting to Client/Clients. `folder_label_*` is LEFT ALONE and continues to name the folder tree.

This is a deliberate departure from P3, which repurposed the existing columns. Judge 3 caught the bug: an existing user who set that field to "Projects" would wake up with their client list called Projects. Two new columns cost nothing and produce zero surprise. Both pairs are edited in `AccountPanel.tsx`.

Seeded defaults by first business type: services -> Client/Clients, products -> Supplier/Suppliers, code -> Customer/Customers, content -> Contact/Contacts.

=== TWO NEW EMPTY STATES, both honest rather than nagging ===

Retailer opening Work: "Boards for your own work. Nothing here belongs to a customer." No prompt to add a client.
Agency with zero orgs: "Add the first client, or start a board for your own work." Two buttons, because internal work is a legitimate first move and the current product implies it is not.


## Where the judges disagreed, and how it was resolved

Five substantive disagreements. Each resolved with a reason, not a compromise.

=== 1. TWO IDENTITY TABLES (organisations + contacts) OR ONE (parties)? ===

Judge 1 called two tables a FATAL flaw in both P1 and P3: `kind enum('company','person')` on the org table sitting beside a separate `contacts` table means nothing says when a sole trader is an org row versus a contact row, so a freelancer client becomes both, two phone numbers, drift, the QuickBooks failure recreated one level up. Judges 2 and 3 both called P2's single-table version unshippable and unusable respectively.

RESOLVED: keep TWO tables, and **delete the `kind` enum entirely**. Judge 1's fatal was not "two tables", it was "no rule for choosing". So there is a rule with no judgement in it:

> Every counterparty is an organisation. A contact is never a counterparty. `documents`, `subscriptions`, `portal_users`, `expenses` and `deals` point ONLY at `organisations`.

A sole trader gets an organisation row (the thing you invoice) and a contact row (the human you email), and the UI collapses them: the New Contact form auto-creates the matching org, and the org page shows a single person inline. There is no fork in the road, so there is nothing to get wrong.

The duplication is then killed at the schema level rather than by discipline: `organisations` has NO `email` and NO `phone` column, only `billing_email` and `billing_phone`. A person's own email and phone exist in exactly one place, `contacts`. There is no column pair that can drift.

The cost is one thin extra row per sole trader. The gain is that every FK in the system has exactly one target, which is the polymorphic-FK problem solved by construction, and that is the actual benefit Judge 1 was reaching for.

=== 2. `hourlyRate`: on folders, or moved to the organisation? ===

Judge 1 preferred P2's approach (copy every level's rate to `hourly_rate_override`, add an org-level default, prove equivalence). Judges 2 and 3 both explicitly said keep it on folders, and Judge 2 called the two existing ancestor walks the subtlest silent-money surface in the codebase.

RESOLVED IN FAVOUR OF JUDGES 2 AND 3, with Judge 1's safety check adopted anyway. `folders.hourly_rate` is not renamed, not copied, not touched. `organisations.hourly_rate` is added as a NEW LAST fallback and is NULL for every migrated row, so `rateFor()` returns byte-identical numbers on the day it ships. There is no equivalence to prove because nothing changed, and the equivalence gate runs in phase 5 regardless because it costs nothing and is the only thing that would catch a mistake. Same treatment for `monthly_hours_budget`: it stays on folders. An agency pricing Design and Development differently under one client keeps working.

=== 3. The id-preservation trick: best idea, or fatal? ===

Judge 3 called it "the best single idea in all three proposals". Judge 2 called it FATAL, on the grounds that MariaDB InnoDB does not persist AUTO_INCREMENT across a restart, so the guard evaporates.

BOTH ARE RIGHT ABOUT DIFFERENT THINGS, and the split is clean:
- Judge 2 is right that MariaDB recomputes AUTO_INCREMENT on table open, so after a restart new org ids overlap the folder id space again. Judge 2 is wrong that this is corruption: `organisations` and `folders` are separate tables, so no duplicate key is possible; the recompute is over `organisations` itself and cannot collide with anything.
- The genuine danger is the SEMANTIC, not the sequence: any code that assumes `org.id === folder.id` is wrong for post-migration rows, silently, with no type error. And `importAccount.ts` remaps ids, so the equality holds in the source workspace and breaks in every restored one, which is the worst possible detection profile.

RESOLVED: **use the trick, forbid the semantic, and make the relationship explicit.** It stays a one-time backfill mechanic, which is where all its value is (it turns seven repointing joins into seven column copies). `organisations.legacy_folder_id` is the queryable, restore-safe form of the relationship, and any code needing "the org from folder X" reads that. No `organisationId ?? folderId` fallback is written anywhere in the codebase; that construct is exactly what silently accepts a wrong id. One integration test asserts it.

=== 4. `work_type` enum, or `pillar` plus invariants? ===

Judge 1 wanted P2's `folders.work_type enum('client','internal','other')` on the grounds that a single nullable `organisation_id` means three things at once.

RESOLVED AGAINST THE NEW ENUM, but the concern is answered. `pillar` already exists and is read in six files (`dashboard.ts:37`, `seed.ts:67`, `handoff.ts:61`, `account.ts`, `search.ts:54`, `Sidebar.tsx:312`). Renaming it is churn for no user-visible gain. Instead: `pillar='operations'` is ENFORCED on write to imply `organisation_id IS NULL` and `is_billable=false`; the "other" case (work for a supplier or partner) is "org set, org has no `customer` role", which is derivable and needs no third value; and "client work not yet linked" is the reconciliation screen's query, empty by construction after phase 5. Three meanings, three closed paths, one boolean column instead of a six-file rename.

=== 5. `accounts.folderLabelSingular`: repurpose, or add new columns? ===

P3 repurposed it to name the organisation. Judge 3 caught the bug: an existing user who set that to "Projects" wakes up with their client list called Projects, and P3 only said defaults are seeded.

RESOLVED: **new columns.** `accounts.org_label_singular` / `org_label_plural`, seeded from the existing folder labels in the phase 1 migration, with `folder_label_*` left alone to keep naming the tree. Two columns cost nothing and produce zero surprise, and it separates two labels that were only ever one because the schema conflated the client with the folder.

=== 6. Hard merge or soft merge? ===

P2 proposed `parties.merged_into_id` and a surviving tombstone. Judge 1 called it FATAL: every read path across 33 files must remember to follow the pointer, and one that forgets renders a real-looking company with zero invoices, which is indistinguishable from a quiet client and is the hardest class of bug to notice.

RESOLVED IN FAVOUR OF JUDGE 1: hard merge, rows repointed, loser deleted, full snapshot in `organisation_merges.payload` as the undo. That is what HubSpot and Salesforce do.


## The phased migration


### Phase 0: Pre-flight audit (read-only, no DDL, run and read by a human)

*Ships on its own: yes. Risk: None. Read-only.*

A `GET /api/v1/admin/directory-audit` endpoint plus a one-page report. Costs an hour and every proposal's backfill is wrong for at least one of these categories.

(a) OPERATIONS-PILLAR ROOT FOLDERS THAT ARE ACTUALLY CLIENTS: `parentId IS NULL AND pillar='operations'` AND (`billing_email IS NOT NULL` OR referenced by a document, subscription or portal_user). `pillar` has never been enforced anywhere and `routes/folders.ts:37` accepts it on create and update with nothing tying it to the billing fields, so this state is reachable today. These MUST become organisations too, and they are flipped to `pillar='delivery'` in phase 2 with every id written to the run log. If missed, that client's hours vanish from every rollup and the number is quietly wrong. This is the failure to lose sleep over.

(b) NON-ROOT FOLDERS CARRYING BILLING DETAILS: `parentId IS NOT NULL AND (billing_email IS NOT NULL OR billing_vat_number IS NOT NULL OR billing_address IS NOT NULL OR billing_phone IS NOT NULL)`. Reachable because `routes/folders.ts:122-129` patches `billingPhone` and `hourlyRate` on any folder id with no root check. Listed for human decision; their values are copied to the root's org and flagged. They must not be silently dropped in the contract phase.

(c) ORPHANS: documents and expenses with `folder_id IS NULL` from a past purge (the FK is already SET NULL). Counted. They cannot be auto-attached.

(d) PORTAL DUPLICATE EMAILS: `SELECT folder_id_root, email, COUNT(*) FROM portal_users ... HAVING COUNT(*) > 1` after mapping each folder to its root. Must be ZERO before the `(organisation_id, email)` unique index can be created in phase 5. Resolution is: keep the oldest, set `is_active=false` on the rest, write the losers into `organisation_merges.payload`. Never delete a login.

(e) ROOT FOLDERS SHARING A NAME INSIDE ONE BUSINESS: listed, never auto-merged.

(f) ORPHANED `deals.contact_id` VALUES: `deals.contactId` is a bare int with no FK (schema.ts:1459). Any orphans block the FK added in phase 1.


### Phase 1: EXPAND: pure additive DDL + export/import lockstep. Buildable today, changes nothing.

*Ships on its own: yes. Risk: Near zero. The only real risk is the FK on `deals.contact_id` failing on orphans, which audit (f) catches first.*

**This is the phase that must not break the running app, and it cannot, because nothing reads any of it.**

Migration `drizzle/0069_directory_expand.sql`:
- CREATE TABLE `organisations`, `organisation_roles`, `organisation_merges`.
- ALTER `accounts` ADD `org_label_singular` varchar(40) DEFAULT 'Client' NOT NULL, ADD `org_label_plural` varchar(40) DEFAULT 'Clients' NOT NULL; then `UPDATE accounts SET org_label_singular = folder_label_singular, org_label_plural = folder_label_plural`.
- ALTER `folders` ADD `organisation_id` int unsigned NULL, ADD CONSTRAINT ... **ON DELETE SET NULL**; ADD `is_billable` tinyint(1) NOT NULL DEFAULT 1.
- ALTER ADD nullable `organisation_id` (FK SET NULL) to: `documents`, `subscriptions`, `portal_users`, `calendar_events`, `contacts`, `deals`.
- ALTER `expenses` ADD `supplier_organisation_id` int unsigned NULL FK SET NULL; same on `recurring_expenses`.
- ALTER `organisations` ADD FK on `primary_contact_id` -> `contacts.id` SET NULL.
- ALTER `deals` ADD FK on `contact_id` -> `contacts.id` SET NULL (guarded by audit (f)).

Code, same release:
- Add the three tables to `EXPECTED_TABLES` in `api/src/db/migrate.ts:10`. That list is a boot-time guard and a missing entry means a skipped migration goes unnoticed.
- **Add the three tables and every new column to `api/src/lib/export.ts` and `api/src/lib/importAccount.ts` NOW, in this release.** `export.ts:59` selects `folders.billingEmail` by name and `importAccount.ts:255-260` writes it back. If those are not updated in lockstep with the DDL, the backup silently stops round-tripping and nobody finds out until a restore is needed. Prove a full export/import round-trip on a copy of production before shipping.
- Write `drizzle/0074_directory_contract.sql` NOW, in the same pull request, guarded so it no-ops until its precondition count is zero. It is not a plan, it is code that runs itself the moment it is safe.
- Add a startup assertion in `server.ts` that logs loudly when any org-bearing root folder still holds a non-null `billing_email`.

Nothing in the app reads or writes the new columns. Fully reversible by dropping.


### Phase 2: BACKFILL IDENTITY: organisations from root folders, id-preserved

*Ships on its own: yes. Risk: Low. The known trap is audit (a); if a client is mis-filed under operations and missed, it gets no org and vanishes from client rollups. That is why phase 0 output is read by a human.*

One idempotent script, looping PER ACCOUNT with `accountId` as a required argument, never one global statement. A cross-account name match would be the worst possible bug in a multi-tenant product.

```sql
INSERT INTO organisations
  (id, account_id, business_id, name, billing_email, billing_phone, billing_address,
   billing_vat_number, color, image_path, notes, is_archived, deleted_at,
   legacy_folder_id, created_by, created_at)
SELECT id, account_id, business_id, name, billing_email, billing_phone, billing_address,
   billing_vat_number, color, image_path, notes, is_archived, deleted_at,
   id, created_by, created_at
FROM folders
WHERE account_id = ? AND parent_id IS NULL
  AND (pillar = 'delivery' OR id IN (<audit 0a list>));

ALTER TABLE organisations AUTO_INCREMENT = (SELECT MAX(id)+1 FROM folders);
```

STRICTLY 1:1. No merging, no fuzzy matching, no name normalisation. `deleted_at` and `is_archived` are COPIED, not filtered: a trashed client becomes a trashed organisation and nothing is lost.

THE ID TRICK, and its exact limits. Inserting each org with its root folder's own id makes every later repoint `SET organisation_id = folder_id`, a copy rather than a join across seven tables, which removes the highest-consequence class of migration bug (an invoice or a portal login attached to the wrong client). Judge 3 called it the best idea in all three proposals; Judge 2 called it fatal. Both are partly right, so:
- It is a ONE-TIME BACKFILL MECHANIC and never a semantic. `organisations.legacy_folder_id` is the explicit, queryable form of the relationship. Any code that needs "the org that came from folder X" reads that column.
- **No `organisationId ?? folderId` fallback is ever written anywhere.** That is the construct that would silently accept a wrong id.
- MariaDB InnoDB does not persist AUTO_INCREMENT across a server restart; it recomputes MAX(id)+1 when the table is opened. That recompute is over `organisations` itself, so no duplicate key is possible (they are separate tables), but new org ids WILL overlap the folder id space after a restart. This is harmless as long as the semantic is forbidden, which is why it is forbidden.
- `importAccount.ts` remaps ids through separate maps, so the equality holds in the source workspace and breaks in every restored one. One integration test asserts no read path assumes it.

Then: `UPDATE folders f JOIN <root map> SET f.organisation_id = <root org id>` for the whole tree, using the same 100-iteration guarded walk as `reports.ts:61`.
Then: audit-0a folders flip to `pillar='delivery'`, logged.
Then: `UPDATE folders SET is_billable = 0 WHERE pillar='operations'`.

Still nothing reads it. Reversible by TRUNCATE plus nulling `folders.organisation_id`.


### Phase 3: BACKFILL THE LINKS: money columns by copy, then roles and lifecycle

*Ships on its own: yes. Risk: Low. Everything is a copy or an insert into an empty table.*

Pure copies, protected by the id trick.

```sql
UPDATE subscriptions SET organisation_id = folder_id WHERE account_id = ?;   -- folder_id was NOT NULL, all roots
UPDATE portal_users  SET organisation_id = folder_id WHERE account_id = ?;
UPDATE deals    SET organisation_id = client_folder_id WHERE client_folder_id IS NOT NULL AND account_id = ?;
UPDATE contacts SET organisation_id = folder_id        WHERE folder_id IS NOT NULL AND account_id = ?;
```
For `documents` and `calendar_events`, which can hang off a SUB-folder, resolve through the folder's root:
```sql
UPDATE documents d JOIN folders f ON f.id = d.folder_id AND f.account_id = d.account_id
  SET d.organisation_id = f.organisation_id
  WHERE d.account_id = ? AND f.organisation_id IS NOT NULL;
```
`documents.folder_id` is KEPT and re-meaned as "which project this bills for". Information gained, none lost.

**`expenses.supplier_organisation_id` IS NOT BACKFILLED. It stays NULL.** Both P1 and P3 proposed writing the root CLIENT's org into an expense's org column and then deriving `supplier` from it, which would label every client with a tagged expense a supplier on day one. `expenses.folder_id` keeps its existing job (`reports.ts:132` attributes cost to a client's root folder). The supplier column fills in as people start tagging.

DERIVE ROLES AND LIFECYCLE (`source='derived'` on every row):
- `customer` where the org has any document, any subscription, or any deal at `stage='won'`. `first_at = MIN(issue_date, created_at)`.
- `supplier`: thin to empty at migration, correctly.
- `lifecycle='prospect'` where no derived roles AND an open deal exists; `archived` where `is_archived`; otherwise `'active'`.
- **DELIBERATELY CONSERVATIVE: never demote an existing folder-client to `prospect`.** A false `active` is invisible; a real client demoted to prospect is a support ticket.

Still nothing reads it. All columns dual-populated.


### Phase 4: SHIP THE SCREENS: Directory, org record page, org chips. First user-visible release.

*Ships on its own: yes. Risk: Medium-low. All reads are additive; the old path is untouched and still authoritative.*

New `routes/organisations.ts` (list, get, create, patch, archive, roles add/remove, merge, timeline). New `web/src/components/DirectoryView.tsx` and `OrganisationPage.tsx`. `ContactsView.tsx` becomes the People sub-tab. `ClientTimeline.tsx` re-points to `/organisations/:id/timeline`.

Register the view: `Sidebar.tsx:53` `AREAS[sales].views`, `PageHeader.tsx:56`, `CommandPalette.tsx:82`.

Add the two module keys to `lib/modules.ts`. Add `lib/orgRoles.ts`. Add `lib/directory.ts` with `orgOf()` and `syncDerivedRoles()`; wire the nightly reconciler into `lib/jobs.ts` beside the digest run, gated on enabled modules.

**Billing details stay READ FROM FOLDERS in this phase.** Writes go to BOTH (`folders.billing_*` and `organisations.billing_*`) from the one form on the org record page. A nightly reconciliation compares the two and alerts on drift. This is the window where mistakes surface cheaply.

SHIP THE RECONCILIATION SCREEN HERE, not as a script: every deal and contact with free-text `company` and `organisation_id IS NULL`, with "create company" and "link to existing" buttons, proposing exact normalised-name matches only. **Nothing is auto-created and nothing is auto-merged.** Same treatment for the audit-0c orphans, which keep their `clientName`/`clientEmail` snapshot and may never link. Every confirmed merge writes an `organisation_merges` row. Identity resolution is human judgement, not migration.

The Directory works from this release. The owner gets the entire user-visible answer to his question here, with the plumbing still on the old path.


### Phase 5: FLIP READS + TIGHTEN CONSTRAINTS (the only phase with real risk)

*Ships on its own: yes. Risk: HIGH, and it is the only high one. Every DDL LOOSENS a constraint except the two NOT NULLs, both gated by an aborting count. Rollback is possible while phase-4 dual-write is still populating the legacy columns, which it is.*

GATE FIRST, before anything flips. **Compute the new `rateFor(folderId)` against the existing ancestor walks in `reports.ts:66` AND `documents.ts:1116` for every folder in production and require ZERO differences.** Rate drift is the one failure here that surfaces months later as a client querying an invoice. It should be impossible by construction (org rates are all NULL) but the check costs nothing and is the only thing that would catch it.

GATE SECOND: assert `SELECT COUNT(*) FROM subscriptions WHERE organisation_id IS NULL` = 0 and `... FROM portal_users ...` = 0, and re-run audit (d). Any non-zero ABORTS the migration.

Migration `0073_directory_flip.sql`:
- `subscriptions.organisation_id` -> NOT NULL, FK **ON DELETE RESTRICT**. You can no longer remove an org that owes you money on a standing arrangement.
- `subscriptions.folder_id` -> NULLABLE, FK changed from **CASCADE to SET NULL**. **This kills a live data-loss bug.** Today `subscriptions.folderId` is `notNull().references(folders.id, { onDelete: 'cascade' })` (schema.ts:974) and the nightly purge in `lib/jobs.ts:178` hard-deletes trashed folder subtrees after 30 days. There is a hold for folders with live hosting (`lib/hosting.ts:896`), but a client with a subscription and no hosting has no guard at all: trash the folder, wait a month, and the subscription row is gone through the FK along with its `payfastToken` and its debit consent.
- `portal_users.organisation_id` -> NOT NULL, FK CASCADE (deleting the org genuinely should remove the login). DROP INDEX `uniq_portal_user`; CREATE UNIQUE INDEX on `(organisation_id, email)`. `folder_id` -> nullable SET NULL. Same cascade fix.

Code:
- `reports.ts:61` `rootOf()` returns `root.organisationId`; `perClient` keys on org id. A client with two folders collapses from two rows to one. **This changes numbers on a screen the owner reads weekly. Ship it with a note.**
- `portal.ts` scoping (`:49`, `:400`, `:477`, `:528`, `:607`, `:651`) moves to `organisation_id`. The comment at `portal.ts:34` warns that dropping the client filter is catastrophic; the org filter preserves the same both-filters-never-one shape (`eq(documents.organisationId, c.user.organisationId)` alongside `accountId`).
- `lib/portalAuth.ts`: `PortalContext.client` becomes an organisation row. **The preview token is the only token change**: `signPreviewToken` carries `oid` alongside `fid` from phase 4, and the preview branch at line 120 accepts either. Live client sessions are unaffected because line 127 re-queries `portal_users` by `payload.pid` and takes the scope from the ROW.
- `lib/hosting.ts`: `billingEmailFor()` (line 402) and `clientNameFor()` (line 409) read the org; `ensurePortalUser()` (line 715) keys on `organisation_id` or it will write rows that violate the new unique index. `lib/messaging.ts` `phoneForClient` likewise. `lib/billing.ts`, `lib/autoDebit.ts`, `lib/settle.ts`, `lib/statement.ts`, `lib/mrr.ts` all key on org.
- `routes/documents.ts:1119` ancestor walk for billing details is DELETED and replaced with one join. The migration makes the money code shorter, which is the honest test of whether the schema change was right.
- `routes/trash.ts` restore clears `organisations.deleted_at` for the folder's org; the purge in `jobs.ts` soft-deletes the org when it purges the last folder that referenced it.

DEPLOY WINDOW: not within three days of any `subscriptions.next_bill_date`, with the billing cron paused for the duration.


### Phase 6: CONTRACT (guarded, written in phase 1's PR, fires itself)

*Ships on its own: yes. Risk: Low by the time it fires, because it is gated on a count. The real risk is that it never fires, which is why it is code rather than a plan.*

`drizzle/0074_directory_contract.sql`, already merged in phase 1, no-ops until:
`SELECT COUNT(*) FROM folders WHERE parent_id IS NULL AND pillar='delivery' AND organisation_id IS NULL` returns 0, AND a full billing cycle has run clean.

Then:
- `CREATE TABLE folders_billing_archive AS SELECT id, account_id, billing_email, billing_phone, billing_vat_number, billing_address FROM folders;` (kept indefinitely, included in exports)
- `ALTER TABLE folders DROP COLUMN billing_email, billing_phone, billing_vat_number, billing_address;`
- `ALTER TABLE contacts DROP COLUMN folder_id;`
- Delete the `fid` branch in the preview path of `portalAuth.ts`, at least one token lifetime after phase 5.

KEPT permanently: `folders.hourly_rate` (now a project override), `folders.monthly_hours_budget`, `documents.folder_id` (project attribution), `expenses.folder_id` (cost attribution), **`subscriptions.folder_id`** (which work this retainer funds; the monthly-hours comparison wants it, and P3 was wrong to drop it), `deals.client_folder_id`, `deals.company` and the contact triple.


## Risks

- THE CLIENT FILED UNDER OPERATIONS. `pillar` has never been enforced: `routes/folders.ts:37` accepts it on create and update with nothing tying it to the billing fields. A client mis-filed under operations gets no organisation in phase 2, and their hours then vanish from every per-client rollup with no error. This is the failure to lose sleep over. Mitigated by audit (a) in phase 0, whose output is read by a human, not by a script. If missed, the fix is to create the org by hand and re-run the folder link, which is recoverable but only once someone notices the number is wrong.
- BILLING FIELDS ON A NON-ROOT FOLDER. Reachable today because `routes/folders.ts:122-129` patches `billingPhone` and `hourlyRate` on any folder id with no root check. If dropped silently in the contract phase, a VAT number disappears from a live invoice template. Mitigated by audit (b), by copying those values up to the root's org, and by `folders_billing_archive` being a table rather than a DROP.
- PORTAL UNIQUE-INDEX COLLISION. Today two folders for one client can each carry `client@example.com`. Moving to `(organisation_id, email)` makes those a duplicate key and the phase 5 DDL fails mid-migration. Mitigated by audit (d) run again immediately before the index swap, in the same window. Resolution keeps the oldest row, deactivates the rest, and writes the losers into `organisation_merges.payload`. Never delete a login.
- THE NIGHTLY RECONCILER STOMPING A MANUAL ROLE. `syncDerivedRoles()` must carry `source='derived'` in its WHERE clause. A missing predicate silently deletes every hand-set partner and referrer tag in the account, with no error and nothing to restore from. It gets its own test, and the test is the point of the column.
- THE ID-SEMANTIC LEAK. `organisation.id === folder.id` holds for migrated rows and breaks for new ones after a MariaDB restart, and breaks in every workspace restored through `importAccount.ts`, which remaps ids. Any `organisationId ?? folderId` fallback silently accepts a wrong value. Mitigated by `legacy_folder_id` as the explicit relationship, a codebase-wide ban on that fallback construct, and one integration test that creates a folder and an org post-migration and asserts nothing resolves by id equality.
- REPORTS CHANGE SHAPE. Keying the per-client rollup on `organisation_id` instead of root folder id collapses a client with two folders from two rows into one. That is a fix, and it changes numbers on a screen the owner reads weekly. It ships with a note in the release, not silently.
- TRASH AND RESTORE ORPHANS. A folder restored from trash whose organisation is still `deleted_at`-stamped is a client with no company. `routes/trash.ts` restore must clear `organisations.deleted_at` for the folder's org, and the purge in `lib/jobs.ts:178` must soft-delete the org when it removes the last folder that referenced it, rather than leaving a live org pointing at nothing. The trash tests need rewriting in the phase 5 release, because the whole point of that release is that trashing a folder no longer touches subscriptions or portal users.
- EXPORT AND IMPORT FALLING OUT OF STEP. `export.ts:59` names folder billing columns explicitly and `importAccount.ts:255-260` writes them back. If the new tables are not added in the SAME release as the DDL, backups silently stop being restorable and nobody finds out until a restore is needed. This is the difference between a recoverable mistake and an unrecoverable one, and it is why it is phase 1 work rather than cleanup.
- BUSINESS SCOPING AND THE NULLABLE `businessId`. `organisations.business_id` nullable means "shared across every business in the workspace". `businessScope()` in `lib/access.ts:136` returns `inArray(column, [...allowed])` for a restricted member, which EXCLUDES NULL rows. So a plain member with access to one business would not see shared organisations at all. This needs an explicit `or(isNull(column), inArray(...))` variant for orgs, and getting it wrong in the other direction is a cross-business data leak inside one tenant. `contacts` and `calendar_events` already carry a nullable businessId, so the pattern exists, but it has not been exercised for a row type that holds money.
- FREE-TEXT RESOLUTION IS HUMAN WORK, NOT A SCRIPT. `deals.company` and `contacts.company` across a few years will contain "Acme", "ACME Pty Ltd" and "acme pty". Nothing auto-merges and nothing auto-creates. That means the Directory under-counts "billed this year" for those rows until someone works through the reconciliation screen. Budget an afternoon of the owner's time per business, say so in the UI, and never let a script guess.
- PHASE 6 NEVER FIRING. The shared fatal risk of every expand-and-contract plan, and the one all three judges named. Until it fires, a client's billing details exist in two writable places with a dual-write between them, and a missed write path fails silently: the old value keeps being served with no error, just a stale VAT number on an invoice. Mitigated by shipping the contract migration in phase 1's pull request as guarded code, and by the startup assertion that logs loudly on drift. This reduces the risk. It does not remove it, and it is the honest weak point of the whole plan.
- THE BILLING-CYCLE WINDOW. Phase 5 changes `subscriptions` constraints and the billing cron's read path. It must not deploy within three days of any `next_bill_date`, and the cron must be paused for the duration. A workspace with twenty clients will never feel the difference between `subscriptions.folder_id` and `subscriptions.organisation_id`. It will very much feel a failed migration on the fifth of the month.

## Deliberately not doing

- THE FULL PARTY MODEL (one `parties` table, `party_role_types`, `party_links`, rules-as-data). Klippy's binding constraint is not join performance, it is that one person maintains this codebase and will one day hand it over. `role_type_relationship` tables declaring which roles may relate to which, plus attribute tables and business-rule tables, are the inner-platform effect: a database inside the database. A role lookup is fine; a metadata engine is not. Kimball's point also bites: even with a party model in the transactional schema you still end up maintaining a flat list for reporting and exports, so you own both plus the transformation, where before you owned one.
- A SINGLE `type` ENUM ON THE ORGANISATION ROW. The dealership case breaks it on day one. Four vendors shipped it, hit the wall, and paid for the migration in public with dated breaking changes. Salesforce's default picklist still contains the fused value 'Customer - Channel', which is the visible symptom of a single-valued field encoding two dimensions. Nobody has ever migrated in the other direction.
- A JSON OR COMMA-STRING TAG SET FOR ROLES. The benchmark that makes tag sets look attractive is a PostgreSQL `int[]` with a GIN index. Klippy is MariaDB: no arrays, no GIN, no multi-valued indexes. `FIND_IN_SET` and `JSON_CONTAINS` are unindexable full scans, and the Directory runs one count per role chip on every load. It also has nowhere to put `source`, `first_at` or `ended_at`, which are the three things that make the role table worth having.
- SPLITTING CUSTOMERS AND SUPPLIERS INTO SEPARATE TABLES OR MODULES (Zoho's shape). It forces genuine duplicate records for the dealership case, and Zoho's own supported remedy is a destructive conversion that deletes the original record. One table with multi-valued roles handles every case Zoho needs two modules for, and produces the net-position line that Zoho structurally cannot.
- A `contact_organisations` MANY-TO-MANY JUNCTION. Not now. The owner's complaint is entirely on the organisation axis. Salesforce built this and pays for it permanently (standard report types exclude related contacts, Pardot honours only the primary, private-sharing orgs cannot see them, mass updates need Data Loader) and STILL kept `Contact.AccountId` as the primary path. A large share of Klippy's counterparties will be sole traders where the junction is pure overhead. The footprint is left: `organisations.id` is stable from day one, and the junction backfills from `contacts.organisation_id` in one additive migration whenever a real requirement appears.
- MANDATORY CLIENT FK ON WORK (Accelo, Teamwork, Harvest). Accelo's own documentation tells you to create a company record for yourself for internal work. Every report in those systems then filters your own company out by name, and it gets worse once partners and suppliers also hold work. Klippy gets Productive's and Scoro's shape for free because `folders.organisation_id` is nullable.
- PRODUCTIVE'S SERVICE AND BUDGET BILLING SPINE. It earns its keep only when one project bills across several budgets or one budget spans projects. Klippy has neither, and adding a services and budgets layer between time entries and invoices is the largest rewrite available here. The parent chain is kept.
- RENAMING `pillar` TO `work_type`, and RENAMING `deals.clientFolderId` TO `wonFolderId`. Both are cosmetic and both touch five or six files including `export.ts` and `importAccount.ts`, where a missed rename breaks restores silently. The invariants do the work the rename was supposed to do.
- REPURPOSING `accounts.folderLabelSingular` / `folderLabelPlural` TO NAME THE ORGANISATION. An existing user who set that to 'Projects' would wake up with their client list called Projects. Two new columns seeded from the old ones cost nothing.
- SOFT MERGE VIA `merged_into_id`. A tombstone that 33 files must remember to follow. The one path that forgets renders a real-looking company with zero invoices, zero deals and zero hours, which is indistinguishable from a genuinely quiet client. Hard merge with a full snapshot audit row instead.
- RENAMING `contacts` TO `contacts_legacy` BEHIND A MySQL VIEW. `routes/crm.ts:71`, `:99` and `:117` do direct INSERT, UPDATE and DELETE against the `contacts` object, and a view over another table whose `company` column derives from a join is not insertable, updatable or deletable in MariaDB. Contact create, edit and delete would break on release day. Drizzle does not model views either, so it would protect only raw SQL.
- PER-ACCOUNT FEATURE FLAGS FOR THE READ FLIP. P2's phase 6 assumed flag infrastructure that does not exist anywhere in this codebase; grepping for flag or rollout returns nothing. That is unbudgeted platform work standing between two phases. The read flip is one release, gated by two aborting assertions and a rate-equivalence check, deployed in a billing-quiet window.
- AN `organisationId` COLUMN ON `sales` (counter takings). A card-machine tap has no counterparty and must never be forced to invent one. This is the retailer's main money path and it stays free of the Directory entirely.
- A `kind enum('company','person')` COLUMN ON `organisations`. It creates a choice with no rule behind it, which is exactly how a sole trader ends up as two rows with two phone numbers. Every counterparty is an organisation; every human is a contact; `organisations` carries no personal email or phone at all, so there is no column that can drift.
- AN `organisationId` ON `tasks` OR `time_entries`. Derivable through two joins that every query in `reports.ts` already performs, and it would go stale the moment a board is moved between folders, which is a supported operation that must re-attribute its time.
- A FILES TAB ON THE ORGANISATION RECORD PAGE, in v1. All three proposals promised it and none can build it: `storage_nodes` (schema.ts:610) has `parentId` and nothing else, no folder link, no task link, no client link. Cut and listed as deferred rather than promised and quietly dropped.