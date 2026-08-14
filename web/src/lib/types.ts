export interface User {
  id: number;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  accountId: number;
  dailyDigest?: boolean;
  theme?: 'system' | 'dark' | 'light';
  accent?: string;
}
export interface Account {
  id: number;
  name: string;
  slug: string;
  plan: string;
  folderLabelSingular: string;
  folderLabelPlural: string;
  brandName?: string | null;
  hasLogo?: boolean;
  currency?: string;
}
export interface Subscription {
  id: number;
  businessId: number;
  status: 'active' | 'paused' | 'canceled';
  /** Billing cadence in months: 1 monthly, 3 quarterly, 12 annually. */
  intervalMonths: number;
  startedOn: string;
  nextBillDate: string;
  lastBilledAt: string | null;
  offeringId: number;
  offeringName: string;
  price: string;
  unit: string | null;
  folderId: number;
  clientName: string;
  autoSend?: boolean;
  /** Charge the saved card each cycle without the client present. */
  autoDebit?: boolean;
  /** Whether a card token is stored. Never the token itself. */
  hasCard?: boolean;
  /** The domain this subscription hosts, when it provisions hosting. */
  domain?: string | null;
}
export interface Offering {
  id: number;
  accountId: number;
  businessId: number;
  name: string;
  description: string | null;
  price: string;
  cost: string | null;
  unit: string | null;
  recurring: boolean;
  stockQty: number | null;
  reorderPoint: number | null;
  active: boolean;
  /** 'cpanel' means paying an invoice for this creates a hosting account. */
  provisioning?: 'none' | 'cpanel';
  whmPackage?: string | null;
  position: number;
}
export interface Expense {
  id: number;
  accountId: number;
  businessId: number;
  folderId: number | null;
  description: string;
  category: string | null;
  amount: string;
  incurredOn: string;
}
export type BusinessType = 'services' | 'products' | 'code' | 'content';
export interface Business {
  id: number;
  accountId: number;
  name: string;
  type: BusinessType;
  secondaryTypes: BusinessType[];
  color: string;
  notes?: string | null;
  // Brand + invoicing identity (what a client sees on this business's documents).
  brandName?: string | null;
  logoPath?: string | null;
  /** What this business bills in. Null inherits the workspace currency. */
  currency?: string | null;
  bizAddress?: string | null;
  bizTaxNumber?: string | null;
  bizRegNumber?: string | null;
  bankDetails?: string | null;
  invoiceFooter?: string | null;
  invoiceAccent?: string;
  defaultTaxRate?: string | null;
  defaultDueDays?: number;
  /** Module keys this business shows, already resolved from its type's defaults. */
  modules?: string[];
  /** Typefaces from the curated Google Fonts list; null means the house fonts. */
  fontDisplay?: string | null;
  fontBody?: string | null;
  /** Custom document blocks, in the restricted HTML subset. Sanitised on save. */
  invoiceHeaderHtml?: string | null;
  invoiceFooterHtml?: string | null;
  /** Which PDF design this business's documents use, and its print typeface. */
  pdfTemplate?: string | null;
  pdfTypeface?: string | null;
  pdfIssuerPlacement?: string | null;
  /** Document numbering: prefix per type, and where the count starts. */
  prefixInvoice?: string | null;
  prefixQuote?: string | null;
  prefixCreditNote?: string | null;
  seqStartInvoice?: number | null;
  seqStartQuote?: number | null;
  seqStartCreditNote?: number | null;
  remindersEnabled?: boolean;
  reminderOffsets?: number[] | null;
  suspendAfterDays?: number | null;
  position: number;
}
export interface Folder {
  id: number;
  accountId: number;
  businessId: number | null;
  parentId: number | null;
  name: string;
  color: string;
  notes: string | null;
  imagePath?: string | null;
  hourlyRate?: string | null;
  /** Where this client's invoices and payment reminders are sent. */
  billingEmail?: string | null;
  /** Billing details the client maintains themselves in their portal. */
  billingVatNumber?: string | null;
  billingAddress?: string | null;
  pillar?: 'delivery' | 'operations';
  isArchived: boolean;
  position: number;
}
export interface Board {
  id: number;
  accountId: number;
  folderId: number;
  name: string;
  description: string | null;
  isArchived: boolean;
  position: number;
}
export interface Column {
  id: number;
  accountId: number;
  boardId: number;
  name: string;
  position: number;
  color: string;
  isDoneColumn: boolean;
}
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export interface Task {
  id: number;
  accountId: number;
  boardId: number;
  columnId: number;
  title: string;
  description: string | null;
  priority: Priority;
  dueDate: string | null;
  // Time blocking: how long it should take, and when it is planned for.
  estimateMinutes: number | null;
  scheduledStart: string | null;
  recurrence: 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly';
  assignedTo: number | null;
  position: number;
  isCompleted: boolean;
  completedAt: string | null;
  isArchived: boolean;
}
export interface Label {
  id: number;
  name: string;
  color: string;
}
export interface CardLabel extends Label {
  taskId: number;
}
export interface TeamUser {
  id: number;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  isActive: boolean;
  lastLogin: string | null;
}
export interface SearchResult {
  id: number;
  title: string;
  priority: Priority;
  dueDate: string | null;
  isCompleted: boolean;
  boardId: number;
  boardName: string | null;
  folderName: string | null;
}
export interface BoardFull {
  board: Board;
  columns: Column[];
  tasks: Task[];
  cardLabels: CardLabel[];
}
export interface Subtask {
  id: number;
  taskId: number;
  title: string;
  isCompleted: boolean;
  position: number;
}
export interface Comment {
  id: number;
  comment: string;
  createdAt: string;
  userId: number;
  authorName: string | null;
}
export interface TaskDetail {
  task: Task;
  subtasks: Subtask[];
  comments: Comment[];
  labels: Label[];
}
export interface CalendarTask {
  id: number;
  title: string;
  priority: Priority;
  dueDate: string;
  boardId: number;
  columnId: number;
  isCompleted: boolean;
}
