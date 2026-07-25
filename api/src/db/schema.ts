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
  mysqlEnum, timestamp, decimal, index, uniqueIndex, type AnyMySqlColumn,
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
  accent: varchar('accent', { length: 20 }).default('violet').notNull(),
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

// ---- Folders (nestable tree; top level = the account's "Clients"/"Businesses") ----
// parentId NULL => top-level folder. Self-referencing for arbitrary depth.
export const folders = mysqlTable('folders', {
  id: pk(),
  accountId: int('account_id', { unsigned: true }).notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  parentId: int('parent_id', { unsigned: true })
    .references((): AnyMySqlColumn => folders.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 150 }).notNull(),
  color: varchar('color', { length: 20 }).default('#6366f1').notNull(),
  notes: text('notes'),
  // Optional logo/image for this business or client, shown in the sidebar.
  imagePath: varchar('image_path', { length: 255 }),
  // Billing rate for work logged under this client, in the workspace currency.
  hourlyRate: decimal('hourly_rate', { precision: 10, scale: 2 }),
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
export type Membership = typeof memberships.$inferSelect;
export type Role = Membership['role'];
