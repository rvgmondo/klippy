import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  businesses, folders, boards, boardColumns, tasks, timeEntries, contacts,
  deals, dealActivities, documents, documentLines, payments, offerings, subscriptions, expenses,
  taskSubtasks, taskComments, taskFiles, labels, taskLabels, teams, teamMembers, boardTeams,
  calendarEvents, storageNodes, hostingAccounts, portalUsers, productNotes,
} from '../db/schema.js';
import { tenantWhere } from './tenant.js';

/**
 * Everything in one workspace as one plain JSON object.
 *
 * Lives in a lib because two things need it and must agree: the Settings
 * "Download everything" button, and the weekly backup email. Data that can only
 * leave the app by hand is data that leaves the app never; the whole point of a
 * backup is that it exists BEFORE the day you need it.
 *
 * TWO RULES, both load-bearing.
 *
 * 1. Every table lists its columns BY NAME. That explicit allow-list is how secrets
 *    stay out by construction rather than by remembering: subscriptions.payfastToken,
 *    portal_users.passwordHash, the encrypted SMTP and WhatsApp credentials, API
 *    token hashes. Never replace one of these with a bare `select()`, or the Sunday
 *    email posts a workspace's credentials to an inbox every week. Settings tables
 *    (payment_settings, hosting_settings, business_email, messaging_settings) and
 *    api_tokens are left out entirely for the same reason: they are all secret and
 *    none of them is business data you would need back.
 *
 * 2. It has to be COMPLETE enough to rebuild from. It used to cover 14 of the 44
 *    tables while the email called itself "a full export of everything", so card
 *    comments, subtasks, attachments, labels, files, the calendar and the register of
 *    live cPanel accounts were all absent. Two omissions mattered most, and both are
 *    fixed here: hosting_accounts (which sites exist on the real server) and
 *    subscriptions.domain (WITHOUT it a rebuilt workspace re-provisions on a holding
 *    domain instead of colliding, and you end up paying for a second live account for
 *    a customer who already has one).
 *
 * Still not a restore path. Nothing consumes this file yet; importing it is its own
 * piece of work with its own guards, and until that exists the copy around this must
 * say "download" and not "restore".
 */

/** Bumped when the SHAPE changes, so a future importer can tell what it is holding. */
export const EXPORT_SCHEMA_VERSION = 2;

export async function buildAccountExport(accountId: number): Promise<Record<string, unknown>> {
  const own = <T extends Parameters<typeof tenantWhere>[0]>(t: T) => tenantWhere(t, accountId);

  const [
    biz, folderRows, boardRows, columnRows, taskRows, timeRows, contactRows,
    dealRows, dealActivityRows, docRows, lineRows, paymentRows, offeringRows, subscriptionRows, expenseRows,
    subtaskRows, commentRows, fileRows, labelRows, taskLabelRows,
    teamRows, teamMemberRows, boardTeamRows, eventRows, storageRows,
    hostingRows, portalRows, noteRows,
  ] = await Promise.all([
    db.select({ id: businesses.id, name: businesses.name, type: businesses.type, currency: businesses.currency, brandName: businesses.brandName, bizAddress: businesses.bizAddress, bizTaxNumber: businesses.bizTaxNumber, bizRegNumber: businesses.bizRegNumber, bankDetails: businesses.bankDetails, defaultTaxRate: businesses.defaultTaxRate, defaultDueDays: businesses.defaultDueDays, prefixInvoice: businesses.prefixInvoice, prefixQuote: businesses.prefixQuote, prefixCreditNote: businesses.prefixCreditNote, seqStartInvoice: businesses.seqStartInvoice, seqStartQuote: businesses.seqStartQuote, seqStartCreditNote: businesses.seqStartCreditNote, position: businesses.position }).from(businesses).where(own(businesses)),
    db.select({ id: folders.id, name: folders.name, parentId: folders.parentId, businessId: folders.businessId, pillar: folders.pillar, billingEmail: folders.billingEmail, billingPhone: folders.billingPhone, billingVatNumber: folders.billingVatNumber, billingAddress: folders.billingAddress, hourlyRate: folders.hourlyRate, monthlyHoursBudget: folders.monthlyHoursBudget, notes: folders.notes, isArchived: folders.isArchived, deletedAt: folders.deletedAt, position: folders.position }).from(folders).where(own(folders)),
    db.select({ id: boards.id, folderId: boards.folderId, name: boards.name, description: boards.description, isArchived: boards.isArchived, deletedAt: boards.deletedAt, position: boards.position }).from(boards).where(own(boards)),
    db.select({ id: boardColumns.id, boardId: boardColumns.boardId, name: boardColumns.name, position: boardColumns.position }).from(boardColumns).where(own(boardColumns)),
    db.select({ id: tasks.id, boardId: tasks.boardId, columnId: tasks.columnId, title: tasks.title, description: tasks.description, priority: tasks.priority, dueDate: tasks.dueDate, estimateMinutes: tasks.estimateMinutes, scheduledStart: tasks.scheduledStart, recurrence: tasks.recurrence, assignedTo: tasks.assignedTo, position: tasks.position, isCompleted: tasks.isCompleted, completedAt: tasks.completedAt, isArchived: tasks.isArchived }).from(tasks).where(own(tasks)),
    db.select({ id: timeEntries.id, taskId: timeEntries.taskId, userId: timeEntries.userId, startTime: timeEntries.startTime, durationSeconds: timeEntries.durationSeconds }).from(timeEntries).where(own(timeEntries)),
    db.select({ id: contacts.id, name: contacts.name, email: contacts.email, phone: contacts.phone, company: contacts.company, role: contacts.role, notes: contacts.notes, folderId: contacts.folderId }).from(contacts).where(own(contacts)),
    db.select({ id: deals.id, title: deals.title, company: deals.company, value: deals.value, stage: deals.stage, source: deals.source, lostReason: deals.lostReason, notes: deals.notes, businessId: deals.businessId, clientFolderId: deals.clientFolderId }).from(deals).where(own(deals)),
    db.select({ id: dealActivities.id, dealId: dealActivities.dealId, kind: dealActivities.kind, body: dealActivities.body, occurredAt: dealActivities.occurredAt }).from(dealActivities).where(own(dealActivities)),
    // seq and the deposit/discount split are here so invoice numbering and every
    // printed figure can be reconstructed from the file alone.
    db.select({ id: documents.id, type: documents.type, seq: documents.seq, number: documents.number, clientName: documents.clientName, clientEmail: documents.clientEmail, clientAddress: documents.clientAddress, clientVatNumber: documents.clientVatNumber, folderId: documents.folderId, businessId: documents.businessId, sourceDocumentId: documents.sourceDocumentId, subscriptionId: documents.subscriptionId, issueDate: documents.issueDate, dueDate: documents.dueDate, currency: documents.currency, taxRate: documents.taxRate, subtotal: documents.subtotal, taxAmount: documents.taxAmount, discountType: documents.discountType, discountValue: documents.discountValue, discountAmount: documents.discountAmount, depositType: documents.depositType, depositValue: documents.depositValue, depositAmount: documents.depositAmount, total: documents.total, status: documents.status, notes: documents.notes }).from(documents).where(own(documents)),
    db.select({ id: documentLines.id, documentId: documentLines.documentId, description: documentLines.description, detail: documentLines.detail, quantity: documentLines.quantity, unitPrice: documentLines.unitPrice, amount: documentLines.amount, position: documentLines.position }).from(documentLines).where(own(documentLines)),
    db.select({ id: payments.id, documentId: payments.documentId, amount: payments.amount, paidOn: payments.paidOn, method: payments.method, note: payments.note, pfPaymentId: payments.pfPaymentId }).from(payments).where(own(payments)),
    db.select({ id: offerings.id, businessId: offerings.businessId, name: offerings.name, description: offerings.description, price: offerings.price, recurring: offerings.recurring, unit: offerings.unit }).from(offerings).where(own(offerings)),
    // domain, NOT payfastToken. The domain is what stops a rebuild provisioning a
    // second live cPanel account for a customer who already has one.
    db.select({ id: subscriptions.id, businessId: subscriptions.businessId, offeringId: subscriptions.offeringId, folderId: subscriptions.folderId, status: subscriptions.status, price: subscriptions.price, autoSend: subscriptions.autoSend, autoDebit: subscriptions.autoDebit, domain: subscriptions.domain, intervalMonths: subscriptions.intervalMonths, startedOn: subscriptions.startedOn, nextBillDate: subscriptions.nextBillDate, lastBilledAt: subscriptions.lastBilledAt }).from(subscriptions).where(own(subscriptions)),
    db.select({ id: expenses.id, businessId: expenses.businessId, folderId: expenses.folderId, description: expenses.description, category: expenses.category, amount: expenses.amount, vatAmount: expenses.vatAmount, incurredOn: expenses.incurredOn }).from(expenses).where(own(expenses)),
    db.select({ id: taskSubtasks.id, taskId: taskSubtasks.taskId, title: taskSubtasks.title, isCompleted: taskSubtasks.isCompleted, position: taskSubtasks.position }).from(taskSubtasks).where(own(taskSubtasks)),
    db.select({ id: taskComments.id, taskId: taskComments.taskId, userId: taskComments.userId, comment: taskComments.comment, createdAt: taskComments.createdAt }).from(taskComments).where(own(taskComments)),
    // The metadata only. The bytes live on disk and are not in this file, which is
    // why a restore has to treat these as "referenced, not included".
    db.select({ id: taskFiles.id, taskId: taskFiles.taskId, originalName: taskFiles.originalName, storedName: taskFiles.storedName, filesize: taskFiles.filesize, mimeType: taskFiles.mimeType, uploadedAt: taskFiles.uploadedAt }).from(taskFiles).where(own(taskFiles)),
    db.select({ id: labels.id, name: labels.name, color: labels.color }).from(labels).where(own(labels)),
    db.select({ id: taskLabels.id, taskId: taskLabels.taskId, labelId: taskLabels.labelId }).from(taskLabels).where(own(taskLabels)),
    db.select({ id: teams.id, name: teams.name, color: teams.color }).from(teams).where(own(teams)),
    db.select({ id: teamMembers.id, teamId: teamMembers.teamId, userId: teamMembers.userId }).from(teamMembers).where(own(teamMembers)),
    db.select({ id: boardTeams.id, boardId: boardTeams.boardId, teamId: boardTeams.teamId }).from(boardTeams).where(own(boardTeams)),
    db.select({ id: calendarEvents.id, businessId: calendarEvents.businessId, folderId: calendarEvents.folderId, title: calendarEvents.title, description: calendarEvents.description, kind: calendarEvents.kind, startAt: calendarEvents.startAt, endAt: calendarEvents.endAt, allDay: calendarEvents.allDay, location: calendarEvents.location, attendees: calendarEvents.attendees }).from(calendarEvents).where(own(calendarEvents)),
    db.select({ id: storageNodes.id, parentId: storageNodes.parentId, kind: storageNodes.kind, name: storageNodes.name, storageKey: storageNodes.storageKey, size: storageNodes.size, mimeType: storageNodes.mimeType }).from(storageNodes).where(own(storageNodes)),
    // Which sites actually exist on the server. The single most important omission
    // in the old export: without it a rebuilt workspace has no idea what it is
    // already hosting, and the accounts become invisible orphans.
    db.select({ id: hostingAccounts.id, businessId: hostingAccounts.businessId, subscriptionId: hostingAccounts.subscriptionId, domain: hostingAccounts.domain, username: hostingAccounts.username, whmPackage: hostingAccounts.whmPackage, status: hostingAccounts.status, isTemporary: hostingAccounts.isTemporary, tempDomain: hostingAccounts.tempDomain, suspendedAt: hostingAccounts.suspendedAt, createdAt: hostingAccounts.createdAt }).from(hostingAccounts).where(own(hostingAccounts)),
    // Who can reach the client portal. Never passwordHash.
    db.select({ id: portalUsers.id, businessId: portalUsers.businessId, folderId: portalUsers.folderId, email: portalUsers.email, name: portalUsers.name, isActive: portalUsers.isActive }).from(portalUsers).where(own(portalUsers)),
    db.select({ id: productNotes.id, title: productNotes.title, body: productNotes.body, kind: productNotes.kind, status: productNotes.status, priority: productNotes.priority }).from(productNotes).where(own(productNotes)),
  ]);

  return {
    exportedOn: new Date().toISOString().slice(0, 10),
    schemaVersion: EXPORT_SCHEMA_VERSION,
    businesses: biz,
    clients: folderRows,
    boards: boardRows,
    columns: columnRows,
    cards: taskRows,
    subtasks: subtaskRows,
    comments: commentRows,
    attachments: fileRows,
    labels: labelRows,
    cardLabels: taskLabelRows,
    teams: teamRows,
    teamMembers: teamMemberRows,
    boardTeams: boardTeamRows,
    timeEntries: timeRows,
    calendarEvents: eventRows,
    files: storageRows,
    contacts: contactRows,
    deals: dealRows,
    dealActivities: dealActivityRows,
    documents: docRows,
    documentLines: lineRows,
    payments: paymentRows,
    offerings: offeringRows,
    subscriptions: subscriptionRows,
    hostingAccounts: hostingRows,
    portalUsers: portalRows,
    expenses: expenseRows,
    notes: noteRows,
  };
}
