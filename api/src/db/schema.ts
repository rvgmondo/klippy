/**
 * Klippy v2 database schema (Drizzle ORM, MySQL/MariaDB).
 *
 * MULTI-TENANCY: shared-schema. Every tenant-owned table carries `accountId`,
 * indexed leftmost. One `accounts` row == one workspace/business. A user belongs
 * to exactly one account. MySQL has no row-level security, so isolation is
 * enforced in the app via the tenant-scoped query helper (see src/lib/tenant.ts).
 * Rule: never read/write a tenant table without an `accountId` filter.
 *
 * Ported from the v1 PHP schema (../../klippy/sql/schema.sql) + migration_002.
 */
import {
  mysqlTable, int, varchar, text, boolean, datetime, date,
  mysqlEnum, timestamp, decimal, index, uniqueIndex, json, type AnyMySqlColumn,
} from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';

const pk = () => int('id', { unsigned: true }).autoincrement().primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().onUpdateNow().notNull();

// ---- Tenant root -----------------------------------------------------------
export const accounts = mysqlTable('accounts', {
  id: pk(),
  name: varchar('name', { length: 150 }).notNull(),
  slug: varchar('slug', { length: 80 }).notNull(),
  plan: mysqlEnum('plan', ['free', 'pro', 'business']).default('free').notNull(),
  status: mysqlEnum('status', ['active', 'suspended']).default('active').notNull(),
  // What the account calls its top-level folders (renameable in settings):
  // e.g. "Client"/"Clients", "Business"/"Businesses", "Project"/"Projects".
  folderLabelSingular: varchar('folder_label_singular', { length: 40 }).default('Client').notNull(),
  folderLabelPlural: varchar('folder_label_plural', { length: 40 }).default('Clients').notNull(),
  // White-labelling: replace the Klippy name/logo shown inside the app.
  currency: varchar('currency', { length: 3 }).default('ZAR').notNull(),
  brandName: varchar('brand_name', { length: 80 }),
  logoPath: varchar('logo_path', { length: 255 }),
  // ---- Invoicing settings ----------------------------------------------------
  // The "from" side of every quote and invoice, plus the defaults a new one starts
  // with. All optional: an invoice reads fine without them, they just make it look
  // like a real business document instead of a bare table.
  bizAddress: varchar('biz_address', { length: 500 }),      // your address block
  bizTaxNumber: varchar('biz_tax_number', { length: 60 }),  // VAT / tax number
  bizRegNumber: varchar('biz_reg_number', { length: 60 }),  // company registration
  bankDetails: text('bank_details'),                        // EFT details for manual payment
  invoiceFooter: text('invoice_footer'),                    // default notes / terms line
  invoiceAccent: varchar('invoice_accent', { length: 20 }).default('#6366f1').notNull(),
  defaultTaxRate: decimal('default_tax_rate', { precision: 5, scale: 2 }),
  defaultDueDays: int('default_due_days', { unsigned: true }).default(14).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: datetime('deleted_at'),
}, (t) => [
  uniqueIndex('uniq_accounts_slug').on(t.slug),
]);

// ---- Users (GLOBAL identity; workspace access comes from `memberships`) ----
// A person has ONE login and can belong to many workspaces. Anything that needs
// "is this person in this workspace, and with what role" must go through
// `memberships`, never through a column on users.
export const users = mysqlTable('users', {
  id: pk(),
  name: varchar('name', { length: 100 }).notNull(),
  email: varchar('email', { length: 150 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  failedAttempts: int('failed_attempts', { unsigned: true }).default(0).notNull(),
  lockedUntil: datetime('locked_until'),
  lastLogin: datetime('last_login'),
  resetTokenHash: varchar('reset_token_hash', { length: 255 }),
  resetExpires: datetime('reset_expires'),
  // Opt out of the morning "what's due" email.
  dailyDigest: boolean('daily_digest').default(true).notNull(),
  // Appearance is a personal preference, not a workspace one.
  theme: mysqlEnum('theme', ['system', 'dark', 'light']).default('dark').notNull(),
  accent: varchar('accent', { length: 20 }).default('lime').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // One login per email address, across the whole system.
  uniqueIndex('uniq_users_email').on(t.email),
]);

// ---- Memberships (which workspaces a person belongs to, and their role) ----
export const memberships = mysqlTable('memberships', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  userId: int('user_id', { unsigned: true }).notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: mysqlEnum('role', ['owner', 'admin', 'member']).default('member').notNull(),
  // Per-workspace deactivation, so removing someone from one workspace does not
  // touch their access to others.
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('uniq_membership').on(t.accountId, t.userId),
  index('idx_memberships_user').on(t.userId),
]);

// ---- Businesses (a company you run, inside your one account) ----------------
// An account can hold several businesses. Each business has its own pillars,
// folders, pipeline and invoicing; the Home dashboard rolls them all up. This is
// the layer the owner actually thinks in. (The account above is just the tenant
// wall that isolates one customer's data from another when Klippy is sold.)
export const businesses = mysqlTable('businesses', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 150 }).notNull(),
  // What kind of business this is. Drives the example content it's seeded with
  // and (eventually) which type-specific modules show up (inventory, MRR, etc).
  type: mysqlEnum('type', ['services', 'products', 'code', 'content']).default('services').notNull(),
  // A business is rarely just one thing (e.g. an agency that also sells a productized
  // tool). `type` stays fixed after creation (it drove the one-time seed content);
  // these are additional type-specific modules turned on later, purely additive -
  // they just widen which offering fields show by default. Empty array is common.
  secondaryTypes: json('secondary_types').$type<('services' | 'products' | 'code' | 'content')[]>()
    .default([]).notNull(),
  // Which modules this business shows, so a copywriter is not made to look at
  // stock levels. Null means "whatever this business type starts with", which is
  // what almost every business stays on; a stored list is an explicit override.
  modules: json('modules').$type<string[]>(),
  // Typefaces, from a curated Google Fonts list (see web/src/lib/fonts.ts). Null
  // means the house fonts. Applied to the app while this business is focused, and
  // to its invoices.
  fontDisplay: varchar('font_display', { length: 60 }),
  fontBody: varchar('font_body', { length: 60 }),
  // Custom blocks on this business's documents, in a restricted HTML subset that
  // both the on-screen invoice and the pdfkit PDF can render (see lib/template.ts).
  // Sanitised on save; placeholders are filled at render time.
  invoiceHeaderHtml: text('invoice_header_html'),
  invoiceFooterHtml: text('invoice_footer_html'),
  // ---- Document numbering ----------------------------------------------------
  // The prefix on each document type, and the number to start counting from. The
  // start matters when moving from another system: you continue at 1043 rather
  // than restarting at 1, and the next number is always
  // max(highest used + 1, start) so raising it can never collide.
  // Which PDF design this business's documents use, and its typeface. The
  // typeface is sans/serif/mono because pdfkit gets the standard PDF families for
  // free; a real brand font would mean shipping and licensing a TTF.
  pdfTemplate: varchar('pdf_template', { length: 20 }),
  pdfTypeface: varchar('pdf_typeface', { length: 10 }),
  // Where the company's own address, registration and VAT number sit on a
  // document. Wedged beside the logo they crowd the header and compete with the
  // document title; as fine print at the foot they read the way legal details
  // should. Applies to the layouts where it is a genuine choice.
  pdfIssuerPlacement: varchar('pdf_issuer_placement', { length: 12 }),
  prefixInvoice: varchar('prefix_invoice', { length: 12 }),
  prefixQuote: varchar('prefix_quote', { length: 12 }),
  prefixCreditNote: varchar('prefix_credit_note', { length: 12 }),
  seqStartInvoice: int('seq_start_invoice', { unsigned: true }),
  seqStartQuote: int('seq_start_quote', { unsigned: true }),
  seqStartCreditNote: int('seq_start_credit_note', { unsigned: true }),
  color: varchar('color', { length: 20 }).default('#6366f1').notNull(),
  // Free-form notes for this business: strategy, logins to remember, whatever the
  // owner wants kept next to it. Separate from folder/client notes.
  notes: text('notes'),
  // ---- Brand + invoicing identity (this is what a client actually sees) -------
  // A business is the identity, not the account. Its quotes, invoices and emails
  // are branded from here, so one account can run several companies that each look
  // like their own business. brandName falls back to `name` when blank; the rest
  // are the "from" details on a document. Backfilled from the account on migrate.
  brandName: varchar('brand_name', { length: 80 }),
  logoPath: varchar('logo_path', { length: 255 }),
  // What this business bills in. Null inherits the workspace currency, which is
  // what most stay on; a value here is for the account that runs a rand company
  // and a dollar company side by side. Set on the business rather than the client
  // because it is the seller's bank account that decides what can be received,
  // and because every document a business issues has to agree with its own books.
  currency: varchar('currency', { length: 3 }),
  bizAddress: varchar('biz_address', { length: 500 }),
  bizTaxNumber: varchar('biz_tax_number', { length: 60 }),
  bizRegNumber: varchar('biz_reg_number', { length: 60 }),
  bankDetails: text('bank_details'),
  invoiceFooter: text('invoice_footer'),
  invoiceAccent: varchar('invoice_accent', { length: 20 }).default('#6366f1').notNull(),
  defaultTaxRate: decimal('default_tax_rate', { precision: 5, scale: 2 }),
  defaultDueDays: int('default_due_days', { unsigned: true }).default(14).notNull(),
  // ---- Payment reminder schedule (per business) ------------------------------
  // Days relative to an invoice's due date to send a reminder on: negative is
  // before due, 0 is on the due date, positive is overdue. Null means the sensible
  // default ([-3, 0, 7]) - stored nullable so we never depend on a JSON column
  // DEFAULT, which is unreliable on the shared-hosting MySQL. Chasing can be turned
  // off per business, and after `suspendAfterDays` overdue (null = never) the invoice
  // is flagged and a "service at risk" notice is sent instead of another reminder.
  remindersEnabled: boolean('reminders_enabled').default(true).notNull(),
  reminderOffsets: json('reminder_offsets').$type<number[]>(),
  suspendAfterDays: int('suspend_after_days', { unsigned: true }),
  position: int('position', { unsigned: true }).default(0).notNull(),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_businesses_account').on(t.accountId, t.position),
]);

// ---- Business access (which businesses a MEMBER may see, and their role) ----
// Account owners and admins implicitly see and manage every business. A plain
// member sees ONLY the businesses listed here for them, with a per-business role:
//   admin  = manage that business (its settings, invoicing, everything in it)
//   member = work in it, but not change its settings
//   viewer = read only
// No row for a (member, business) pair means no access to that business at all.
export const businessMembers = mysqlTable('business_members', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true }).notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  userId: int('user_id', { unsigned: true }).notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: mysqlEnum('role', ['admin', 'member', 'viewer']).default('member').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('uniq_business_member').on(t.businessId, t.userId),
  index('idx_business_members_user').on(t.accountId, t.userId),
]);

// ---- Per-business email identity -------------------------------------------
// How a business's mail is addressed, so a client sees it come "from" that
// business. All optional: without a row (or with blank fields) mail falls back to
// the business brand name over the global sending address. A business can also plug
// in its OWN SMTP server (advanced, for a business with its own authenticated mail
// domain); the password is encrypted at rest with PAYMENTS_SECRET, like PayFast.
export const businessEmail = mysqlTable('business_email', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true }).notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  // General "from" for anything this business sends.
  fromName: varchar('from_name', { length: 120 }),
  fromEmail: varchar('from_email', { length: 150 }),
  replyTo: varchar('reply_to', { length: 150 }),
  // Per-purpose override for invoices, quotes and payment reminders.
  invoiceFromName: varchar('invoice_from_name', { length: 120 }),
  invoiceFromEmail: varchar('invoice_from_email', { length: 150 }),
  invoiceReplyTo: varchar('invoice_reply_to', { length: 150 }),
  // Optional own SMTP server.
  smtpHost: varchar('smtp_host', { length: 200 }),
  smtpPort: int('smtp_port', { unsigned: true }),
  smtpSecure: boolean('smtp_secure'),
  smtpUser: varchar('smtp_user', { length: 200 }),
  smtpPassEnc: text('smtp_pass_enc'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('uniq_business_email').on(t.businessId),
]);

// ---- Events -----------------------------------------------------------------
// A record of the things the system did on its own, and what came of each. The
// automations are the point of Klippy (a won deal should not need six manual
// follow-ups), but automation you cannot see is automation you cannot trust, so
// every emitted event and every handler's outcome is written down.
export const events = mysqlTable('events', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true }),
  name: varchar('name', { length: 60 }).notNull(),
  // What the event was about, e.g. the deal id and its value.
  payload: json('payload').$type<Record<string, unknown>>(),
  // One line per handler: what it did, or why it did nothing.
  results: json('results').$type<{ handler: string; outcome: string; ok: boolean }[]>(),
  createdAt: createdAt(),
}, (t) => [
  index('idx_events_account').on(t.accountId, t.createdAt),
]);

// ---- Calendar events (meetings, calls, anything with a time) ----------------
// Deliberately NOT called `events`: that table above is the automation audit log.
// A task has a due DATE and belongs to a board; a meeting has a start and end TIME
// and belongs to a client, which is why it is its own thing rather than a flag on
// tasks. Both land on the calendar together.
export const calendarEvents = mysqlTable('calendar_events', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true })
    .references(() => businesses.id, { onDelete: 'cascade' }),
  // The client this is with, when it is with one. Null for internal events.
  folderId: int('folder_id', { unsigned: true }).references(() => folders.id, { onDelete: 'set null' }),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  kind: mysqlEnum('kind', ['meeting', 'call', 'deadline', 'other']).default('meeting').notNull(),
  startAt: datetime('start_at').notNull(),
  endAt: datetime('end_at'),
  // An all-day event has no meaningful time, so the UI shows it as a banner.
  allDay: boolean('all_day').default(false).notNull(),
  location: varchar('location', { length: 255 }),
  // Free text rather than user ids: most attendees are clients, not team members.
  attendees: text('attendees'),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_calendar_events_range').on(t.accountId, t.startAt),
]);

// ---- Folders (nestable tree; top level = a business's "Clients"/areas) ------
// parentId NULL => top-level folder. Self-referencing for arbitrary depth.
export const folders = mysqlTable('folders', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  // Which business this folder belongs to (top-level folders carry it; subfolders
  // inherit their root's business). Nullable during rollout, backfilled on migrate.
  businessId: int('business_id', { unsigned: true })
    .references(() => businesses.id, { onDelete: 'cascade' }),
  parentId: int('parent_id', { unsigned: true })
    .references((): AnyMySqlColumn => folders.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 150 }).notNull(),
  color: varchar('color', { length: 20 }).default('#6366f1').notNull(),
  notes: text('notes'),
  // Optional logo/image for this business or client, shown in the sidebar.
  imagePath: varchar('image_path', { length: 255 }),
  // Where this client's invoices and payment reminders are sent. Without it a
  // recurring invoice can only ever be a draft someone has to email by hand.
  billingEmail: varchar('billing_email', { length: 150 }),
  // Billing rate for work logged under this client, in the workspace currency.
  hourlyRate: decimal('hourly_rate', { precision: 10, scale: 2 }),
  // The client's own billing details, which they can correct in the portal. A
  // wrong VAT number on a tax invoice is the client's problem to spot and ours to
  // print, so letting them fix it is worth more than guarding it.
  billingVatNumber: varchar('billing_vat_number', { length: 60 }),
  billingAddress: text('billing_address'),
  // Which business pillar this top-level folder belongs to.
  pillar: mysqlEnum('pillar', ['delivery', 'operations']).default('delivery').notNull(),
  isArchived: boolean('is_archived').default(false).notNull(),
  position: int('position', { unsigned: true }).default(0).notNull(),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_folders_account_parent').on(t.accountId, t.parentId, t.position),
]);

// ---- Boards ----------------------------------------------------------------
export const boards = mysqlTable('boards', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  folderId: int('folder_id', { unsigned: true }).notNull()
    .references(() => folders.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 150 }).notNull(),
  description: varchar('description', { length: 255 }),
  isArchived: boolean('is_archived').default(false).notNull(),
  position: int('position', { unsigned: true }).default(0).notNull(),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_boards_account_folder').on(t.accountId, t.folderId, t.position),
]);

// ---- Board columns ---------------------------------------------------------
export const boardColumns = mysqlTable('board_columns', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  boardId: int('board_id', { unsigned: true }).notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  position: int('position', { unsigned: true }).default(0).notNull(),
  color: varchar('color', { length: 20 }).default('#94a3b8').notNull(),
  isDoneColumn: boolean('is_done_column').default(false).notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('idx_columns_account_board').on(t.accountId, t.boardId, t.position),
]);

// ---- Tasks (cards) ---------------------------------------------------------
export const tasks = mysqlTable('tasks', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  boardId: int('board_id', { unsigned: true }).notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  columnId: int('column_id', { unsigned: true }).notNull()
    .references(() => boardColumns.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  priority: mysqlEnum('priority', ['none', 'low', 'medium', 'high', 'urgent']).default('none').notNull(),
  dueDate: date('due_date', { mode: 'string' }),
  // TIME BLOCKING. A due date is when it must be finished; these are when you have
  // actually decided to DO it, and how long you think it will take. Together they
  // let the day planner lay work out on a timeline and warn when a day is
  // over-committed, and let Reports compare the estimate against tracked time.
  estimateMinutes: int('estimate_minutes', { unsigned: true }),
  scheduledStart: datetime('scheduled_start'),
  // When a recurring card is completed, the next occurrence is created
  // automatically with the due date advanced by this interval.
  recurrence: mysqlEnum('recurrence', ['none', 'daily', 'weekly', 'biweekly', 'monthly']).default('none').notNull(),
  assignedTo: int('assigned_to', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  position: int('position', { unsigned: true }).default(0).notNull(),
  isCompleted: boolean('is_completed').default(false).notNull(),
  completedAt: datetime('completed_at'),
  isArchived: boolean('is_archived').default(false).notNull(),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_tasks_account_column').on(t.accountId, t.columnId, t.position),
  index('idx_tasks_account_board').on(t.accountId, t.boardId),
  index('idx_tasks_account_due').on(t.accountId, t.dueDate),
  // Day planner: "what is scheduled for this person on this day".
  index('idx_tasks_account_scheduled').on(t.accountId, t.scheduledStart),
]);

// ---- Time entries ----------------------------------------------------------
export const timeEntries = mysqlTable('time_entries', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  taskId: int('task_id', { unsigned: true }).notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  userId: int('user_id', { unsigned: true }).notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  startTime: datetime('start_time').notNull(),
  endTime: datetime('end_time'),
  durationSeconds: int('duration_seconds', { unsigned: true }),
  note: varchar('note', { length: 255 }),
  isManual: boolean('is_manual').default(false).notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('idx_time_account_task').on(t.accountId, t.taskId),
  // Fast lookup of a user's currently-running timer (end_time IS NULL).
  index('idx_time_account_user_open').on(t.accountId, t.userId, t.endTime),
]);

// ---- Focus sessions (Pomodoro-style; may or may not be tied to a task) -----
export const focusSessions = mysqlTable('focus_sessions', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  userId: int('user_id', { unsigned: true }).notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  taskId: int('task_id', { unsigned: true }).references(() => tasks.id, { onDelete: 'set null' }),
  label: varchar('label', { length: 200 }),
  plannedSeconds: int('planned_seconds', { unsigned: true }),
  startTime: datetime('start_time').notNull(),
  endTime: datetime('end_time'),
  durationSeconds: int('duration_seconds', { unsigned: true }),
  status: mysqlEnum('status', ['running', 'completed', 'cancelled']).default('running').notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('idx_focus_account_user').on(t.accountId, t.userId, t.status),
]);

// ---- Subtasks --------------------------------------------------------------
export const taskSubtasks = mysqlTable('task_subtasks', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  taskId: int('task_id', { unsigned: true }).notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  isCompleted: boolean('is_completed').default(false).notNull(),
  position: int('position', { unsigned: true }).default(0).notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('idx_subtasks_account_task').on(t.accountId, t.taskId, t.position),
]);

// ---- Comments --------------------------------------------------------------
export const taskComments = mysqlTable('task_comments', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  taskId: int('task_id', { unsigned: true }).notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  userId: int('user_id', { unsigned: true }).notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  comment: text('comment').notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('idx_comments_account_task').on(t.accountId, t.taskId),
]);

// ---- File attachments ------------------------------------------------------
export const taskFiles = mysqlTable('task_files', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  taskId: int('task_id', { unsigned: true }).notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  userId: int('user_id', { unsigned: true }).notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  originalName: varchar('original_name', { length: 255 }).notNull(),
  storedName: varchar('stored_name', { length: 255 }).notNull(),
  filesize: int('filesize', { unsigned: true }).notNull(),
  mimeType: varchar('mime_type', { length: 100 }).notNull(),
  uploadedAt: createdAt(),
}, (t) => [
  index('idx_files_account_task').on(t.accountId, t.taskId),
]);

// ---- Labels (account-level tags; many-to-many with tasks) ------------------
export const labels = mysqlTable('labels', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 50 }).notNull(),
  color: varchar('color', { length: 20 }).default('#6366f1').notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('idx_labels_account').on(t.accountId),
]);

export const taskLabels = mysqlTable('task_labels', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  taskId: int('task_id', { unsigned: true }).notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  labelId: int('label_id', { unsigned: true }).notNull()
    .references(() => labels.id, { onDelete: 'cascade' }),
}, (t) => [
  uniqueIndex('uniq_task_label').on(t.taskId, t.labelId),
  index('idx_task_labels_account_task').on(t.accountId, t.taskId),
]);

// ---- Teams (named groups of people, attachable to boards) -----------------
export const teams = mysqlTable('teams', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),
  color: varchar('color', { length: 20 }).default('#6366f1').notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('idx_teams_account').on(t.accountId),
]);

export const teamMembers = mysqlTable('team_members', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  teamId: int('team_id', { unsigned: true }).notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  userId: int('user_id', { unsigned: true }).notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [
  uniqueIndex('uniq_team_member').on(t.teamId, t.userId),
  index('idx_team_members_account').on(t.accountId),
]);

export const boardTeams = mysqlTable('board_teams', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  boardId: int('board_id', { unsigned: true }).notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  teamId: int('team_id', { unsigned: true }).notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
}, (t) => [
  uniqueIndex('uniq_board_team').on(t.boardId, t.teamId),
  index('idx_board_teams_account').on(t.accountId),
]);

// ---- API tokens (for the browser extension / integrations) ----------------
// Only the SHA-256 hash is stored; the plaintext token is shown once on create.
export const apiTokens = mysqlTable('api_tokens', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  userId: int('user_id', { unsigned: true }).notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  lastUsedAt: datetime('last_used_at'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('uniq_api_token_hash').on(t.tokenHash),
  index('idx_api_tokens_account_user').on(t.accountId, t.userId),
]);

// ---- Storage (a per-workspace document tree: folders and files) -----------
// One table holds both kinds so a folder can contain folders and files alike.
// `storageKey` is opaque to everything above lib/storage.ts, which is what lets
// the physical backend swap from disk to S3 without touching this schema.
export const storageNodes = mysqlTable('storage_nodes', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  parentId: int('parent_id', { unsigned: true })
    .references((): AnyMySqlColumn => storageNodes.id, { onDelete: 'cascade' }),
  kind: mysqlEnum('kind', ['folder', 'file']).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  // File-only fields; null for folders.
  storageKey: varchar('storage_key', { length: 255 }),
  size: int('size', { unsigned: true }),
  mimeType: varchar('mime_type', { length: 100 }),
  uploadedBy: int('uploaded_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_storage_account_parent').on(t.accountId, t.parentId, t.kind, t.name),
]);

// ---- Product notes (admin backlog: ideas, bugs, review notes) -------------
// A place to capture "we should change X" as it occurs, so the whole list can
// be handed over in one go instead of in dribs and drabs.
export const productNotes = mysqlTable('product_notes', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body'),
  kind: mysqlEnum('kind', ['idea', 'bug', 'improvement', 'question']).default('idea').notNull(),
  status: mysqlEnum('status', ['open', 'planned', 'done', 'dropped']).default('open').notNull(),
  priority: mysqlEnum('priority', ['low', 'medium', 'high']).default('medium').notNull(),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_notes_account_status').on(t.accountId, t.status, t.createdAt),
]);

// ---- Web push subscriptions (one row per browser/device per user) ---------
export const pushSubscriptions = mysqlTable('push_subscriptions', {
  id: pk(),
  userId: int('user_id', { unsigned: true }).notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  endpoint: varchar('endpoint', { length: 500 }).notNull(),
  p256dh: varchar('p256dh', { length: 255 }).notNull(),
  auth: varchar('auth', { length: 255 }).notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('uniq_push_endpoint').on(t.endpoint),
  index('idx_push_user').on(t.userId),
]);

// ---- Documents: quotes and invoices (same shape, one table) ---------------
export const documents = mysqlTable('documents', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true })
    .references(() => businesses.id, { onDelete: 'cascade' }),
  type: mysqlEnum('type', ['quote', 'invoice', 'credit_note']).notNull(),
  seq: int('seq', { unsigned: true }).notNull(),          // per-business, per-type running number
  number: varchar('number', { length: 30 }).notNull(),    // e.g. INV-0001
  // A quote the client has accepted or declined in the portal, and who by. Kept
  // on the document rather than in a side table because it IS a fact about the
  // quote, and the date they agreed is the thing you need when the work is
  // disputed months later.
  /**
   * When this invoice's recurring lines were turned into subscriptions.
   *
   * The idempotency guard, and it lives here rather than on the lines because
   * editing a document DELETES and re-inserts every line. A marker on the line
   * would be wiped by an ordinary edit, and the next payment would start a second
   * set of subscriptions for the same sale.
   */
  subscriptionsStartedAt: datetime('subscriptions_started_at'),

  decision: mysqlEnum('decision', ['accepted', 'declined']),
  decisionAt: datetime('decision_at'),
  decisionBy: varchar('decision_by', { length: 150 }),

  // For a credit note: the invoice it credits. Null for invoices/quotes.
  sourceDocumentId: int('source_document_id', { unsigned: true }),
  folderId: int('folder_id', { unsigned: true }).references(() => folders.id, { onDelete: 'set null' }),
  // The subscription cycle that raised this invoice, if any. Without it there is no
  // way back from an invoice to the subscription it came from, which auto-debit
  // needs twice over: to ask PayFast for a reusable token when the client pays this
  // one by hand, and to know which stored token to charge for the next cycle.
  subscriptionId: int('subscription_id', { unsigned: true }),
  clientName: varchar('client_name', { length: 150 }).notNull(),
  clientEmail: varchar('client_email', { length: 150 }),
  clientAddress: text('client_address'),
  // The client's VAT number, for a full tax invoice (SARS requires it above R5000).
  clientVatNumber: varchar('client_vat_number', { length: 60 }),
  issueDate: date('issue_date', { mode: 'string' }).notNull(),
  dueDate: date('due_date', { mode: 'string' }),          // invoice due / quote valid-until
  status: mysqlEnum('status', ['draft', 'sent', 'accepted', 'paid', 'void']).default('draft').notNull(),
  // Last date a payment reminder went out, so chasing does not repeat daily.
  lastReminderOn: date('last_reminder_on', { mode: 'string' }),
  // Set when the final "service at risk / suspended" notice went out, after the
  // business's suspend threshold. Drives the Collections list's flagged state.
  suspendedAt: datetime('suspended_at'),
  currency: varchar('currency', { length: 3 }).default('ZAR').notNull(),
  // Discount applied to the subtotal before tax. 'none' | 'percent' | 'amount';
  // discountAmount is the resolved money value, stored so totals are self-contained.
  discountType: mysqlEnum('discount_type', ['none', 'percent', 'amount']).default('none').notNull(),
  discountValue: decimal('discount_value', { precision: 12, scale: 2 }).default('0').notNull(),
  discountAmount: decimal('discount_amount', { precision: 12, scale: 2 }).default('0').notNull(),
  taxRate: decimal('tax_rate', { precision: 5, scale: 2 }).default('0').notNull(),
  subtotal: decimal('subtotal', { precision: 12, scale: 2 }).default('0').notNull(),
  taxAmount: decimal('tax_amount', { precision: 12, scale: 2 }).default('0').notNull(),
  total: decimal('total', { precision: 12, scale: 2 }).default('0').notNull(),
  notes: text('notes'),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // Numbering is per business now, so the sequence is unique within a business.
  // businessId is nullable; MySQL allows multiple NULLs here, so legacy business-less
  // documents do not collide.
  uniqueIndex('uniq_doc_number').on(t.accountId, t.businessId, t.type, t.seq),
  // The portal reads every document for ONE client, and the hosting flow reads
  // every document for ONE subscription. Neither had an index that fit: both fell
  // back to the account prefix and scanned the rest, which is fine at a hundred
  // documents and not at ten thousand.
  index('idx_docs_account_folder').on(t.accountId, t.folderId),
  index('idx_docs_account_subscription').on(t.accountId, t.subscriptionId),
  index('idx_docs_account_type').on(t.accountId, t.type, t.createdAt),
]);

export const documentLines = mysqlTable('document_lines', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  documentId: int('document_id', { unsigned: true }).notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  description: varchar('description', { length: 500 }).notNull(),
  /**
   * The longer version, printed under the line title.
   *
   * A description column wide enough to say what was actually delivered is the
   * difference between an invoice a client pays and one they email back asking
   * what it was for. Kept separate from `description` rather than letting that
   * grow, because the two are different things on the page: the title labels the
   * row and lines up with the quantity and price, the detail sits under it in
   * smaller grey text. One field could not be set in two typefaces, and a
   * paragraph in the title column pushes the figures out of alignment.
   *
   * Filled from the offering's own description when one is picked, and editable
   * afterwards, because the standard blurb usually wants a sentence about THIS
   * client's job.
   */
  detail: text('detail'),
  quantity: decimal('quantity', { precision: 10, scale: 2 }).default('1').notNull(),
  unitPrice: decimal('unit_price', { precision: 12, scale: 2 }).default('0').notNull(),
  amount: decimal('amount', { precision: 12, scale: 2 }).default('0').notNull(),
  /**
   * The offering this line is selling, when it is one.
   *
   * Free text was fine while an invoice was only a bill. It is not fine now that
   * selling something can START something: a line reading "Monthly hosting" told
   * Klippy nothing, so adding hosting to an invoice billed the client once and set
   * up no subscription, no renewal and no cPanel account.
   */
  offeringId: int('offering_id', { unsigned: true }),
  /**
   * Bill this again every N months, so a recurring thing sold on an invoice
   * actually recurs. Null is a one-off line, which is most of them. Copied from
   * the offering when it is picked, but overridable, because the same hosting
   * package gets sold monthly to one client and annually to another.
   */
  recurringMonths: int('recurring_months', { unsigned: true }),
  /**
   * The subscription this line started once the invoice was paid.
   *
   * The idempotency marker, and the reason it lives on the LINE rather than being
   * inferred from client plus offering: a hosting client can legitimately buy the
   * same package twice for two different sites, and a rule of "they already have
   * one of these" would silently refuse the second sale.
   */
  startedSubscriptionId: int('started_subscription_id', { unsigned: true }),
  position: int('position', { unsigned: true }).default(0).notNull(),
}, (t) => [
  index('idx_doclines_account_doc').on(t.accountId, t.documentId, t.position),
]);

// ---- Payments recorded against an invoice ---------------------------------
export const payments = mysqlTable('payments', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  documentId: int('document_id', { unsigned: true }).notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  paidOn: date('paid_on', { mode: 'string' }).notNull(),
  method: varchar('method', { length: 40 }),
  note: varchar('note', { length: 255 }),
  // PayFast's own payment id, for gateway payments. A UNIQUE index on it turns a
  // duplicate or concurrent ITN retry into a no-op insert instead of a second
  // payment row that would double the paid total and drive outstanding negative.
  // Null for manual/EFT payments; MySQL allows many nulls in a unique index, so
  // hand-entered payments are unaffected.
  pfPaymentId: varchar('pf_payment_id', { length: 64 }),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [
  index('idx_payments_account_doc').on(t.accountId, t.documentId),
  uniqueIndex('uniq_payments_pf').on(t.pfPaymentId),
]);

// ---- Offerings ("The Offering": what the business actually sells. Shape is the
// same table for every business type - only which fields matter changes: a
// services catalog uses price+unit, Products additionally uses cost/stockQty/
// reorderPoint, Code marks recurring=true for MRR, Content just uses price+unit.)
export const offerings = mysqlTable('offerings', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true }).notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 150 }).notNull(),
  description: text('description'),
  price: decimal('price', { precision: 12, scale: 2 }).default('0').notNull(),
  cost: decimal('cost', { precision: 12, scale: 2 }),          // COGS - mainly Products
  unit: varchar('unit', { length: 30 }),                        // "hour" / "unit" / "month" / "post"...
  recurring: boolean('recurring').default(false).notNull(),    // contributes to MRR - mainly Code
  stockQty: int('stock_qty'),                                   // mainly Products
  reorderPoint: int('reorder_point'),                           // mainly Products
  active: boolean('active').default(true).notNull(),
  // What selling this should set up automatically. 'cpanel' means a paid invoice
  // for this offering creates a hosting account on the WHM server, using the
  // package named here. 'none' is everything else, which is most things.
  provisioning: mysqlEnum('provisioning', ['none', 'cpanel']).default('none').notNull(),
  whmPackage: varchar('whm_package', { length: 60 }),
  position: int('position', { unsigned: true }).default(0).notNull(),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_offerings_account_business').on(t.accountId, t.businessId, t.position),
]);

// ---- Expenses ("Financial Viability"'s missing half: cost structure, not just
// revenue. Deliberately simple - a dated ledger line, not full accounting.)
export const expenses = mysqlTable('expenses', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true }).notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  // Optional: which client/project this cost belongs to, so profit can be shown per
  // client, not just for the business overall. Null means general overhead.
  folderId: int('folder_id', { unsigned: true }).references(() => folders.id, { onDelete: 'set null' }),
  description: varchar('description', { length: 200 }).notNull(),
  category: varchar('category', { length: 60 }),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  incurredOn: date('incurred_on', { mode: 'string' }).notNull(),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_expenses_account_business').on(t.accountId, t.businessId, t.incurredOn),
]);

// ---- Subscriptions (recurring billing: ties a recurring Offering to a specific
// client/folder, and drives the monthly invoice the cron job generates) ----------
export const subscriptions = mysqlTable('subscriptions', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true }).notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  offeringId: int('offering_id', { unsigned: true }).notNull()
    .references(() => offerings.id, { onDelete: 'cascade' }),
  folderId: int('folder_id', { unsigned: true }).notNull()
    .references(() => folders.id, { onDelete: 'cascade' }),
  status: mysqlEnum('status', ['active', 'paused', 'canceled']).default('active').notNull(),
  // What THIS client pays, when it is not the list price.
  //
  // Null means "whatever the offering costs", which is what most subscriptions are
  // and what every one of them was before this column existed. A value here is a
  // negotiated rate: the same retainer at 9,000 for one client and 7,500 for
  // another, without cloning the offering once per client and turning the price
  // list into a client list.
  //
  // The distinction is deliberate and useful in both directions. Raise the list
  // price and everyone on null follows; everyone on a negotiated rate does not,
  // which is exactly what a negotiated rate means.
  price: decimal('price', { precision: 12, scale: 2 }),
  // Email the generated invoice to the client instead of leaving a draft for
  // someone to send by hand. The whole point of a recurring charge.
  autoSend: boolean('auto_send').default(false).notNull(),
  // PayFast tokenization token, captured the first time a client pays this
  // subscription online. With it, later cycles can be charged automatically
  // (auto-debit) instead of only emailing an invoice. Null until they pay once.
  payfastToken: varchar('payfast_token', { length: 100 }),
  // Per-subscription consent to debit the stored card without the client present.
  // Separate from having a token on purpose: a client paying one invoice online is
  // not the same as agreeing to be charged every month, and in South Africa a debit
  // arrangement needs the customer's mandate. Off until someone turns it on.
  autoDebit: boolean('auto_debit').default(false).notNull(),
  // The domain this subscription is for, when it provisions hosting.
  //
  // Usually blank at the point of sale, because the CLIENT is the only one who
  // knows it. You sell hosting, they decide the domain, and often those are days
  // apart. So this is filled in by whoever knows: typed here if you already have
  // it, otherwise asked of the client and filled in by them.
  domain: varchar('domain', { length: 190 }),
  // When we last asked the client for the domain, so the request is sent once
  // rather than on every payment, and so an unanswered one is visible.
  domainRequestedAt: datetime('domain_requested_at'),
  // How often this bills, in months: 1 monthly, 3 quarterly, 12 annually. Hosting
  // and domains are usually sold by the year, so monthly-only was a real gap.
  intervalMonths: int('interval_months', { unsigned: true }).default(1).notNull(),
  startedOn: date('started_on', { mode: 'string' }).notNull(),
  nextBillDate: date('next_bill_date', { mode: 'string' }).notNull(),
  lastBilledAt: datetime('last_billed_at'),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_subscriptions_account_status').on(t.accountId, t.status, t.nextBillDate),
]);

// ---- Payment provider settings (per account) -------------------------------
// One row per account, holding its PayFast credentials so clients can pay
// invoices online. The merchant key and passphrase are SECRETS: stored
// encrypted (AES-256-GCM, key from the PAYMENTS_SECRET env var), never returned
// to the browser in the clear, never logged. `enabled` gates everything, and it
// defaults off, so nothing charges until the owner has entered and tested their
// own credentials. Separate table (not columns on accounts) so these secrets are
// never pulled in by an ordinary account lookup.
export const paymentSettings = mysqlTable('payment_settings', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  /**
   * Which business these credentials belong to, or 0 for the whole workspace.
   *
   * Businesses are usually separate legal entities with separate bank accounts, so
   * one gateway for the workspace would pay every business's invoices into
   * whichever merchant account was set up first. That is the kind of mistake you
   * find out about from your accountant months later.
   *
   * Zero rather than NULL on purpose: MySQL lets a unique index hold any number of
   * NULLs, so a nullable column here would not actually stop two workspace-default
   * rows existing, and "which of these two merchant accounts gets the money" is not
   * a question anyone should have to answer. There is no foreign key for the same
   * reason, since 0 is not a business.
   */
  businessId: int('business_id', { unsigned: true }).default(0).notNull(),
  provider: varchar('provider', { length: 20 }).default('payfast').notNull(),
  merchantId: varchar('merchant_id', { length: 40 }),
  // Encrypted blobs (iv:tag:ciphertext hex). Never plaintext at rest.
  merchantKeyEnc: text('merchant_key_enc'),
  passphraseEnc: text('passphrase_enc'),
  // Sandbox uses PayFast's test endpoints and credentials; safe to leave on
  // until a real end-to-end payment has been seen to work.
  sandbox: boolean('sandbox').default(true).notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  // ---- Auto-debit (charging a stored card on a schedule) --------------------
  // Three separate switches, because this is the one part of Klippy that moves
  // money without anybody watching, and each guards a different mistake.
  //
  // `autoDebitEnabled` is the master. `autoDebitLive` decides whether the run
  // actually calls PayFast or only writes down what it would have charged: a dry
  // run proves the wiring, the amounts and the client list are right before a cent
  // moves, which is the only safe way to test this. `autoDebitMax` refuses any
  // single charge above it, so a bad price or a stray zero cannot debit a client
  // for a fortune before anyone notices.
  autoDebitEnabled: boolean('auto_debit_enabled').default(false).notNull(),
  autoDebitLive: boolean('auto_debit_live').default(false).notNull(),
  autoDebitMax: decimal('auto_debit_max', { precision: 12, scale: 2 }).default('5000.00').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('uniq_payment_settings_scope').on(t.accountId, t.businessId),
]);

// ---- Client portal ---------------------------------------------------------
/**
 * Someone at a client company who can sign in and see their own account.
 *
 * Tied to a folder, which is how Klippy models a client, and therefore to exactly
 * one business. That is deliberate: businesses here are separate legal entities
 * with separate invoices and separate merchant accounts, so a person who buys from
 * two of them is two portal users seeing two sets of books. Merging them would mean
 * one login showing invoices from two companies, which is wrong on every level.
 *
 * The password is optional. Signing in by emailed link is the default because it
 * needs no password to store, reset or support; a password can be set afterwards by
 * anyone who would rather have one, or whose email is slow.
 */
export const portalUsers = mysqlTable('portal_users', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true }).notNull(),
  folderId: int('folder_id', { unsigned: true }).notNull()
    .references(() => folders.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 150 }).notNull(),
  name: varchar('name', { length: 150 }),
  passwordHash: varchar('password_hash', { length: 100 }),
  isActive: boolean('is_active').default(true).notNull(),
  lastLoginAt: datetime('last_login_at'),
  // Same lockout the staff login has had all along. Without it a portal password
  // can be guessed at indefinitely, and the portal is the internet-facing door.
  failedAttempts: int('failed_attempts', { unsigned: true }).default(0).notNull(),
  lockedUntil: datetime('locked_until'),
  // When a sign-in link was last sent, so the endpoint cannot be used to bombard
  // a client's inbox, or to hammer the mail server, one request at a time.
  lastLinkAt: datetime('last_link_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // One login per person per client. The same address may appear against a
  // different client of a different business, which is the case above.
  uniqueIndex('uniq_portal_user').on(t.folderId, t.email),
  index('idx_portal_user_email').on(t.email),
]);

/**
 * A single-use sign-in link.
 *
 * Only the SHA-256 of the token is stored. A stolen database therefore yields no
 * working links, which matters more here than for an ordinary password reset
 * because this link is itself the credential.
 */
export const portalLoginTokens = mysqlTable('portal_login_tokens', {
  id: pk(),
  portalUserId: int('portal_user_id', { unsigned: true }).notNull()
    .references(() => portalUsers.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  expiresAt: datetime('expires_at').notNull(),
  usedAt: datetime('used_at'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('uniq_portal_token').on(t.tokenHash),
  index('idx_portal_token_user').on(t.portalUserId),
]);

// ---- Hosting provisioning (WHM / cPanel) -----------------------------------
/**
 * Credentials and switches for the WHM server that hosting accounts are created
 * on. One row per account. The API token is a SECRET with root-level power over a
 * whole server, so it is encrypted at rest exactly like the PayFast keys and never
 * returned to the browser.
 *
 * `live` is the same idea as auto-debit's: with it off the whole path runs and
 * writes down what it would have created, without touching the server.
 */
export const hostingSettings = mysqlTable('hosting_settings', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  /** Scoped like payment settings: a business's own server, or 0 for the workspace. */
  businessId: int('business_id', { unsigned: true }).default(0).notNull(),
  whmHost: varchar('whm_host', { length: 190 }),
  whmUser: varchar('whm_user', { length: 60 }).default('root'),
  whmTokenEnc: text('whm_token_enc'),
  // Many WHM boxes serve port 2087 with a self-signed certificate. Verifying is
  // the default; this is the deliberate, per-account opt-out rather than a silent
  // one buried in code.
  allowSelfSigned: boolean('allow_self_signed').default(false).notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  live: boolean('live').default(false).notNull(),
  // Days past due before an account is suspended. Null means never, which is the
  // default: cutting off a customer's website is not something to start doing by
  // accident.
  suspendAfterDays: int('suspend_after_days'),
  // Days before that to warn them. A website going dark with no notice reads as a
  // fault rather than a consequence, and the support call costs more than the
  // invoice. Null means no warning, but the UI defaults it to 3.
  warnBeforeDays: int('warn_before_days').default(3),
  /**
   * How to name a holding domain for a customer who has not bought theirs yet.
   *
   * At the point of sale the client usually has no domain, and refusing to set
   * anything up means somebody has paid and cannot even log in. cPanel is happy to
   * create the account on a domain the HOST controls, so hosting starts working
   * immediately and the real domain is attached later.
   *
   * A pattern rather than a fixed value, because the username has to be in it:
   * "{username}.clients.example.co.za". Null means the feature is off and the old
   * behaviour applies, which is to wait for the client to supply a domain.
   */
  tempDomainPattern: varchar('temp_domain_pattern', { length: 190 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('uniq_hosting_settings_scope').on(t.accountId, t.businessId),
]);

/**
 * A hosting account Klippy has created, one per subscription.
 *
 * Unique on subscriptionId, which is what stops a second payment creating a second
 * cPanel account for the same customer. Note there is no "delete" status: Klippy
 * suspends and unsuspends, but terminating an account destroys the customer's site
 * and mail, and nothing automatic should be able to do that.
 */
export const hostingAccounts = mysqlTable('hosting_accounts', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true }),
  subscriptionId: int('subscription_id', { unsigned: true }).notNull(),
  domain: varchar('domain', { length: 190 }).notNull(),
  username: varchar('username', { length: 32 }),
  whmPackage: varchar('whm_package', { length: 60 }),
  /**
   * True while the account is living on a holding domain we own rather than the
   * customer's own. Kept as its own flag rather than inferred from the domain
   * string, because the pattern can be changed in settings afterwards and an
   * inference would then quietly start lying about existing accounts.
   */
  isTemporary: boolean('is_temporary').default(false).notNull(),
  /** The holding domain, kept after the switch so support can still find the account. */
  tempDomain: varchar('temp_domain', { length: 190 }),
  /** When the account was moved onto the customer's real domain. */
  domainSwitchedAt: datetime('domain_switched_at'),
  status: mysqlEnum('status', ['pending', 'active', 'suspended', 'failed', 'dry-run'])
    .default('pending').notNull(),
  detail: text('detail'),
  // When the "your site will be switched off" warning went out, so the daily job
  // sends it once rather than every morning until the suspension lands. Cleared
  // when the account is paid up, so a later lapse warns again.
  warnedAt: datetime('warned_at'),
  suspendedAt: datetime('suspended_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('uniq_hosting_subscription').on(t.subscriptionId),
  index('idx_hosting_account').on(t.accountId, t.status),
]);

/**
 * One row per attempt to debit a card for an invoice.
 *
 * The unique index on documentId is the safety mechanism, not bookkeeping. The row
 * is written BEFORE PayFast is called, so a second attempt on the same invoice hits
 * a duplicate key and stops. Without that, a job that runs twice (a retry, an
 * overlapping cron, a deploy mid-run) charges the client twice, and taking money
 * back is far harder than not taking it.
 */
export const autoDebitAttempts = mysqlTable('auto_debit_attempts', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  subscriptionId: int('subscription_id', { unsigned: true }).notNull(),
  documentId: int('document_id', { unsigned: true }).notNull(),
  status: mysqlEnum('status', ['pending', 'charged', 'failed', 'skipped', 'dry-run']).default('pending').notNull(),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  detail: text('detail'),
  pfPaymentId: varchar('pf_payment_id', { length: 60 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('uniq_auto_debit_document').on(t.documentId),
  index('idx_auto_debit_account').on(t.accountId, t.createdAt),
]);

// ---- Deals (the Acquisition pillar: a sales pipeline) ---------------------
export const deals = mysqlTable('deals', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true })
    .references(() => businesses.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 150 }).notNull(),
  company: varchar('company', { length: 150 }),
  contactName: varchar('contact_name', { length: 120 }),
  contactEmail: varchar('contact_email', { length: 150 }),
  contactPhone: varchar('contact_phone', { length: 40 }),
  value: decimal('value', { precision: 12, scale: 2 }).default('0').notNull(),
  stage: mysqlEnum('stage', ['lead', 'contacted', 'proposal', 'won', 'lost']).default('lead').notNull(),
  notes: text('notes'),
  position: int('position', { unsigned: true }).default(0).notNull(),
  /**
   * The person, once they are a record rather than three fields.
   *
   * The contactName/Email/Phone columns above stay as the fallback for deals that
   * predate contacts, and for a lead where all you have is a name scribbled down.
   * When contactId is set it wins: one place to correct a phone number, and the
   * same person across three deals is one person.
   */
  contactId: int('contact_id', { unsigned: true }),
  /** Where this lead came from, so you can tell what is actually working. */
  source: varchar('source', { length: 60 }),
  /**
   * When to chase this next, and what about.
   *
   * The single most valuable field here. Deals rarely die because the answer was
   * no; they die because nobody followed up and everyone felt too awkward to ask
   * twice. A date turns that from a memory problem into a list.
   */
  nextFollowUpAt: date('next_follow_up_at', { mode: 'string' }),
  followUpNote: varchar('follow_up_note', { length: 200 }),
  // Set when a won deal is turned into a delivery client.
  clientFolderId: int('client_folder_id', { unsigned: true }).references(() => folders.id, { onDelete: 'set null' }),
  wonAt: datetime('won_at'),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_deals_account_stage').on(t.accountId, t.stage, t.position),
  index('idx_deals_followup').on(t.accountId, t.nextFollowUpAt),
]);

/**
 * A person you deal with, kept once rather than copied onto every deal.
 *
 * Separate from `users` (who work here) and from `folders` (which are client
 * companies). A contact may belong to a client company, or to nobody yet because
 * they are still a lead. Deliberately not unique on email: two people can share an
 * info@ address, and refusing to save the second one helps nobody.
 */
export const contacts = mysqlTable('contacts', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  businessId: int('business_id', { unsigned: true })
    .references(() => businesses.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  email: varchar('email', { length: 150 }),
  phone: varchar('phone', { length: 40 }),
  company: varchar('company', { length: 150 }),
  role: varchar('role', { length: 80 }),
  notes: text('notes'),
  /** The client company they belong to, once there is one. */
  folderId: int('folder_id', { unsigned: true }).references(() => folders.id, { onDelete: 'set null' }),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('idx_contacts_account_business').on(t.accountId, t.businessId),
  index('idx_contacts_email').on(t.accountId, t.email),
]);

/**
 * What has actually happened on a deal: calls, emails, meetings, notes, and the
 * stage moves recorded automatically.
 *
 * Without this a deal is a title and a number, and "where did we leave it" is
 * answered by searching your inbox. Stage changes are logged by the app rather than
 * typed, because the one thing nobody remembers to write down is when it moved.
 */
export const dealActivities = mysqlTable('deal_activities', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  dealId: int('deal_id', { unsigned: true }).notNull()
    .references(() => deals.id, { onDelete: 'cascade' }),
  kind: mysqlEnum('kind', ['note', 'call', 'email', 'meeting', 'stage']).default('note').notNull(),
  body: text('body'),
  occurredAt: datetime('occurred_at').notNull(),
  createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [
  index('idx_deal_activities').on(t.accountId, t.dealId, t.occurredAt),
]);

// ---- Relations (for db.query.* nested reads) ------------------------------
export const accountsRelations = relations(accounts, ({ many }) => ({
  memberships: many(memberships),
  folders: many(folders),
}));
export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));
export const foldersRelations = relations(folders, ({ one, many }) => ({
  account: one(accounts, { fields: [folders.accountId], references: [accounts.id] }),
  parent: one(folders, { fields: [folders.parentId], references: [folders.id], relationName: 'folder_parent' }),
  children: many(folders, { relationName: 'folder_parent' }),
  boards: many(boards),
}));
export const boardsRelations = relations(boards, ({ one, many }) => ({
  folder: one(folders, { fields: [boards.folderId], references: [folders.id] }),
  columns: many(boardColumns),
  tasks: many(tasks),
}));
export const boardColumnsRelations = relations(boardColumns, ({ one, many }) => ({
  board: one(boards, { fields: [boardColumns.boardId], references: [boards.id] }),
  tasks: many(tasks),
}));
export const tasksRelations = relations(tasks, ({ one, many }) => ({
  board: one(boards, { fields: [tasks.boardId], references: [boards.id] }),
  column: one(boardColumns, { fields: [tasks.columnId], references: [boardColumns.id] }),
  assignee: one(users, { fields: [tasks.assignedTo], references: [users.id] }),
  subtasks: many(taskSubtasks),
  comments: many(taskComments),
  files: many(taskFiles),
  timeEntries: many(timeEntries),
}));

// Convenience type exports
export type Account = typeof accounts.$inferSelect;
export type User = typeof users.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Board = typeof boards.$inferSelect;
export type BoardColumn = typeof boardColumns.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type FocusSession = typeof focusSessions.$inferSelect;
export type Label = typeof labels.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type StorageNode = typeof storageNodes.$inferSelect;
export type ProductNote = typeof productNotes.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type DocumentLine = typeof documentLines.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Deal = typeof deals.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Role = Membership['role'];

// ---- Scheduled job runs ----------------------------------------------------
// Bookkeeping for the app's own scheduler. Shared hosting makes external cron a
// chore to set up (and a non-starter if this is ever sold), so the app runs its
// own daily jobs and records here what ran and when. Not tenant-scoped: these
// jobs sweep every account at once, the same way an external cron did.
export const jobRuns = mysqlTable('job_runs', {
  id: pk(),
  name: varchar('name', { length: 60 }).notNull(),
  // Date (not timestamp) because these are once-a-day jobs; it is the thing we
  // compare against "today" to decide whether this one still owes a run.
  lastRunOn: date('last_run_on', { mode: 'string' }),
  lastStatus: mysqlEnum('last_status', ['ok', 'failed']),
  lastMessage: varchar('last_message', { length: 500 }),
  lastRunAt: datetime('last_run_at'),
  enabled: boolean('enabled').default(true).notNull(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('uniq_job_runs_name').on(t.name),
]);
