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
import { mysqlTable, int, varchar, text, boolean, datetime, date, mysqlEnum, timestamp, decimal, index, uniqueIndex, json, } from 'drizzle-orm/mysql-core';
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
    bizAddress: varchar('biz_address', { length: 500 }), // your address block
    bizTaxNumber: varchar('biz_tax_number', { length: 60 }), // VAT / tax number
    bizRegNumber: varchar('biz_reg_number', { length: 60 }), // company registration
    bankDetails: text('bank_details'), // EFT details for manual payment
    invoiceFooter: text('invoice_footer'), // default notes / terms line
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
    secondaryTypes: json('secondary_types').$type()
        .default([]).notNull(),
    // Which modules this business shows, so a copywriter is not made to look at
    // stock levels. Null means "whatever this business type starts with", which is
    // what almost every business stays on; a stored list is an explicit override.
    modules: json('modules').$type(),
    // Typefaces, from a curated Google Fonts list (see web/src/lib/fonts.ts). Null
    // means the house fonts. Applied to the app while this business is focused, and
    // to its invoices.
    fontDisplay: varchar('font_display', { length: 60 }),
    fontBody: varchar('font_body', { length: 60 }),
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
    reminderOffsets: json('reminder_offsets').$type(),
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
    payload: json('payload').$type(),
    // One line per handler: what it did, or why it did nothing.
    results: json('results').$type(),
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
        .references(() => folders.id, { onDelete: 'cascade' }),
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
        .references(() => storageNodes.id, { onDelete: 'cascade' }),
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
    seq: int('seq', { unsigned: true }).notNull(), // per-business, per-type running number
    number: varchar('number', { length: 30 }).notNull(), // e.g. INV-0001
    // For a credit note: the invoice it credits. Null for invoices/quotes.
    sourceDocumentId: int('source_document_id', { unsigned: true }),
    folderId: int('folder_id', { unsigned: true }).references(() => folders.id, { onDelete: 'set null' }),
    clientName: varchar('client_name', { length: 150 }).notNull(),
    clientEmail: varchar('client_email', { length: 150 }),
    clientAddress: text('client_address'),
    // The client's VAT number, for a full tax invoice (SARS requires it above R5000).
    clientVatNumber: varchar('client_vat_number', { length: 60 }),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }), // invoice due / quote valid-until
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
    index('idx_docs_account_type').on(t.accountId, t.type, t.createdAt),
]);
export const documentLines = mysqlTable('document_lines', {
    id: pk(),
    accountId: int('account_id', { unsigned: true }).notNull()
        .references(() => accounts.id, { onDelete: 'cascade' }),
    documentId: int('document_id', { unsigned: true }).notNull()
        .references(() => documents.id, { onDelete: 'cascade' }),
    description: varchar('description', { length: 500 }).notNull(),
    quantity: decimal('quantity', { precision: 10, scale: 2 }).default('1').notNull(),
    unitPrice: decimal('unit_price', { precision: 12, scale: 2 }).default('0').notNull(),
    amount: decimal('amount', { precision: 12, scale: 2 }).default('0').notNull(),
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
    createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
}, (t) => [
    index('idx_payments_account_doc').on(t.accountId, t.documentId),
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
    cost: decimal('cost', { precision: 12, scale: 2 }), // COGS - mainly Products
    unit: varchar('unit', { length: 30 }), // "hour" / "unit" / "month" / "post"...
    recurring: boolean('recurring').default(false).notNull(), // contributes to MRR - mainly Code
    stockQty: int('stock_qty'), // mainly Products
    reorderPoint: int('reorder_point'), // mainly Products
    active: boolean('active').default(true).notNull(),
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
    // Email the generated invoice to the client instead of leaving a draft for
    // someone to send by hand. The whole point of a recurring charge.
    autoSend: boolean('auto_send').default(false).notNull(),
    // PayFast tokenization token, captured the first time a client pays this
    // subscription online. With it, later cycles can be charged automatically
    // (auto-debit) instead of only emailing an invoice. Null until they pay once.
    payfastToken: varchar('payfast_token', { length: 100 }),
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
    provider: varchar('provider', { length: 20 }).default('payfast').notNull(),
    merchantId: varchar('merchant_id', { length: 40 }),
    // Encrypted blobs (iv:tag:ciphertext hex). Never plaintext at rest.
    merchantKeyEnc: text('merchant_key_enc'),
    passphraseEnc: text('passphrase_enc'),
    // Sandbox uses PayFast's test endpoints and credentials; safe to leave on
    // until a real end-to-end payment has been seen to work.
    sandbox: boolean('sandbox').default(true).notNull(),
    enabled: boolean('enabled').default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
}, (t) => [
    uniqueIndex('uniq_payment_settings_account').on(t.accountId),
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
    // Set when a won deal is turned into a delivery client.
    clientFolderId: int('client_folder_id', { unsigned: true }).references(() => folders.id, { onDelete: 'set null' }),
    wonAt: datetime('won_at'),
    createdBy: int('created_by', { unsigned: true }).references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
}, (t) => [
    index('idx_deals_account_stage').on(t.accountId, t.stage, t.position),
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
//# sourceMappingURL=schema.js.map