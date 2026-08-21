import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses, folders, boards, boardColumns, tasks, timeEntries, contacts, deals, documents, documentLines, payments, offerings, subscriptions, expenses, } from '../db/schema.js';
/**
 * Everything in one workspace as one plain JSON object.
 *
 * Lives in a lib because two things need it and must agree: the Settings
 * "Download everything" button, and the weekly backup email. Data that can only
 * leave the app by hand is data that leaves the app never; the whole point of a
 * backup is that it exists BEFORE the day you need it.
 */
export async function buildAccountExport(accountId) {
    const [biz, folderRows, boardRows, columnRows, taskRows, timeRows, contactRows, dealRows, docRows, lineRows, paymentRows, offeringRows, subscriptionRows, expenseRows,] = await Promise.all([
        db.select({ id: businesses.id, name: businesses.name, type: businesses.type, currency: businesses.currency }).from(businesses).where(eq(businesses.accountId, accountId)),
        db.select({ id: folders.id, name: folders.name, parentId: folders.parentId, businessId: folders.businessId, pillar: folders.pillar, billingEmail: folders.billingEmail, notes: folders.notes }).from(folders).where(eq(folders.accountId, accountId)),
        db.select({ id: boards.id, folderId: boards.folderId, name: boards.name, description: boards.description }).from(boards).where(eq(boards.accountId, accountId)),
        db.select({ id: boardColumns.id, boardId: boardColumns.boardId, name: boardColumns.name, position: boardColumns.position }).from(boardColumns).where(eq(boardColumns.accountId, accountId)),
        db.select({ id: tasks.id, boardId: tasks.boardId, columnId: tasks.columnId, title: tasks.title, description: tasks.description, priority: tasks.priority, dueDate: tasks.dueDate, isCompleted: tasks.isCompleted }).from(tasks).where(eq(tasks.accountId, accountId)),
        db.select({ id: timeEntries.id, taskId: timeEntries.taskId, userId: timeEntries.userId, startTime: timeEntries.startTime, durationSeconds: timeEntries.durationSeconds }).from(timeEntries).where(eq(timeEntries.accountId, accountId)),
        db.select({ id: contacts.id, name: contacts.name, email: contacts.email, phone: contacts.phone, company: contacts.company, role: contacts.role, notes: contacts.notes, folderId: contacts.folderId }).from(contacts).where(eq(contacts.accountId, accountId)),
        db.select({ id: deals.id, title: deals.title, company: deals.company, value: deals.value, stage: deals.stage, source: deals.source, lostReason: deals.lostReason, notes: deals.notes, businessId: deals.businessId, clientFolderId: deals.clientFolderId }).from(deals).where(eq(deals.accountId, accountId)),
        db.select({ id: documents.id, type: documents.type, number: documents.number, clientName: documents.clientName, folderId: documents.folderId, businessId: documents.businessId, issueDate: documents.issueDate, dueDate: documents.dueDate, currency: documents.currency, subtotal: documents.subtotal, taxAmount: documents.taxAmount, total: documents.total, status: documents.status }).from(documents).where(eq(documents.accountId, accountId)),
        db.select({ id: documentLines.id, documentId: documentLines.documentId, description: documentLines.description, detail: documentLines.detail, quantity: documentLines.quantity, unitPrice: documentLines.unitPrice, amount: documentLines.amount }).from(documentLines).where(eq(documentLines.accountId, accountId)),
        db.select({ id: payments.id, documentId: payments.documentId, amount: payments.amount, paidOn: payments.paidOn, method: payments.method, note: payments.note }).from(payments).where(eq(payments.accountId, accountId)),
        db.select({ id: offerings.id, businessId: offerings.businessId, name: offerings.name, description: offerings.description, price: offerings.price, recurring: offerings.recurring, unit: offerings.unit }).from(offerings).where(eq(offerings.accountId, accountId)),
        db.select({ id: subscriptions.id, businessId: subscriptions.businessId, offeringId: subscriptions.offeringId, folderId: subscriptions.folderId, status: subscriptions.status, price: subscriptions.price, intervalMonths: subscriptions.intervalMonths, startedOn: subscriptions.startedOn, nextBillDate: subscriptions.nextBillDate }).from(subscriptions).where(eq(subscriptions.accountId, accountId)),
        db.select({ id: expenses.id, businessId: expenses.businessId, folderId: expenses.folderId, description: expenses.description, category: expenses.category, amount: expenses.amount, vatAmount: expenses.vatAmount, incurredOn: expenses.incurredOn }).from(expenses).where(eq(expenses.accountId, accountId)),
    ]);
    return {
        exportedOn: new Date().toISOString().slice(0, 10),
        businesses: biz,
        clients: folderRows,
        boards: boardRows,
        columns: columnRows,
        cards: taskRows,
        timeEntries: timeRows,
        contacts: contactRows,
        deals: dealRows,
        documents: docRows,
        documentLines: lineRows,
        payments: paymentRows,
        offerings: offeringRows,
        subscriptions: subscriptionRows,
        expenses: expenseRows,
    };
}
//# sourceMappingURL=export.js.map