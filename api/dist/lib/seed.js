import { businesses, folders, boards, boardColumns, tasks, deals, offerings } from '../db/schema.js';
import { TEMPLATES } from './templates.js';
const COLUMNS = [
    { name: 'To do', color: '#94a3b8', isDoneColumn: false },
    { name: 'Doing', color: '#3b82f6', isDoneColumn: false },
    { name: 'Done', color: '#22c55e', isDoneColumn: true },
];
// Create a board (with the default 3 columns) under a folder, plus optional starter cards.
async function seedBoard(tx, accountId, userId, folderId, name, description, cards) {
    const boardIns = await tx.insert(boards).values({
        accountId, folderId, name, description, position: 0, createdBy: userId,
    });
    const boardId = Number(boardIns[0].insertId);
    const colIds = [];
    for (let i = 0; i < COLUMNS.length; i++) {
        const c = COLUMNS[i];
        const ins = await tx.insert(boardColumns).values({
            accountId, boardId, name: c.name, color: c.color, isDoneColumn: c.isDoneColumn, position: i,
        });
        colIds.push(Number(ins[0].insertId));
    }
    // Group starter cards by their target column so positions stay clean per column.
    const perColumn = {};
    for (const card of cards) {
        const colIdx = card.column ?? 0;
        const position = perColumn[colIdx] ?? 0;
        perColumn[colIdx] = position + 1;
        await tx.insert(tasks).values({
            accountId, boardId, columnId: colIds[colIdx],
            title: card.title, description: card.description ?? null, position, createdBy: userId,
        });
    }
    return boardId;
}
/**
 * Seed a brand-new business with a working starter setup rather than an empty app.
 *
 * A blank three-pillar structure still leaves you staring at nothing, wondering what
 * belongs where. So each type gets the areas a business of that shape actually runs
 * on, already filled with the recurring work: an example of the thing you deliver,
 * the engine that brings customers in, the money admin, and a pipeline with a deal in
 * each early stage. All of it is ordinary data, so anything that does not fit gets
 * renamed or deleted.
 */
export async function seedNewBusiness(tx, accountId, userId, businessId, type) {
    const t = TEMPLATES[type];
    // DELIVERY then OPERATIONS. Position counts per pillar, since the sidebar groups them.
    for (const [pillar, group] of [['delivery', t.delivery], ['operations', t.operations]]) {
        for (let i = 0; i < group.length; i++) {
            const area = group[i];
            const ins = await tx.insert(folders).values({
                accountId, businessId, parentId: null, name: area.name, pillar, position: i,
                color: pillar === 'delivery' ? '#6366f1' : '#0ea5e9', createdBy: userId, notes: area.notes,
            });
            const folderId = Number(ins[0].insertId);
            for (const b of area.boards) {
                await seedBoard(tx, accountId, userId, folderId, b.name, b.description, b.cards);
            }
        }
    }
    // ACQUISITION: a couple of deals spread across the early stages, so the pipeline
    // reads as a pipeline straight away instead of one lonely card.
    for (let i = 0; i < t.deals.length; i++) {
        const d = t.deals[i];
        await tx.insert(deals).values({
            accountId, businessId, title: d.title, company: d.company ?? null,
            stage: d.stage, value: String(d.value), position: i, notes: d.notes, createdBy: userId,
        });
    }
    // What this business sells, which is what makes Reports and invoicing meaningful.
    for (let i = 0; i < t.offerings.length; i++) {
        const o = t.offerings[i];
        await tx.insert(offerings).values({
            accountId, businessId, name: o.name, price: String(o.price), position: i, createdBy: userId,
            cost: o.cost != null ? String(o.cost) : null, unit: o.unit ?? null, recurring: o.recurring ?? false,
            stockQty: o.stockQty ?? null, reorderPoint: o.reorderPoint ?? null,
        });
    }
}
/** The one folder a new account starts with. The restore check recognises it by this name. */
export const CLEAN_START_FOLDER = 'Internal work';
/**
 * Signup: create the account's first business and give it a clean start.
 *
 * New accounts used to arrive full of made-up clients, deals and prices ("Sample
 * Client", a pipeline of invented companies), which a stranger then had to find
 * and delete before the app showed anything true. Now the first business gets
 * one empty internal board, so a task has somewhere to live, and nothing else.
 * Adding a second business later still offers the example content.
 */
export async function seedNewAccount(tx, accountId, userId, businessName = 'My Business', type = 'services', setup = {}) {
    // secondaryTypes written explicitly: a JSON column DEFAULT needs MySQL 8.0.13+,
    // and a strict-mode server rejects an insert that omits a NOT NULL column whose
    // default it will not honour. Signup must not depend on that.
    const bizIns = await tx.insert(businesses).values({
        accountId, name: businessName, type, secondaryTypes: [], position: 0, createdBy: userId,
        // The blueprint's module set, when signup chose one; null keeps the type default.
        modules: setup.modules ?? null,
        ...(setup.defaultDueDays != null ? { defaultDueDays: setup.defaultDueDays } : {}),
        ...(setup.defaultTaxRate != null ? { defaultTaxRate: setup.defaultTaxRate } : {}),
        ...(setup.bizTaxNumber ? { bizTaxNumber: setup.bizTaxNumber } : {}),
        ...(setup.reminderOffsets ? { reminderOffsets: setup.reminderOffsets } : {}),
        ...(setup.suspendAfterDays !== undefined ? { suspendAfterDays: setup.suspendAfterDays } : {}),
    });
    const businessId = Number(bizIns[0].insertId);
    await seedCleanStart(tx, accountId, userId, businessId);
}
/**
 * The one thing a new business gets: an empty internal "To do" board, so a task has
 * somewhere to live. Used for a new account and for every business added after it.
 * Adding a business used to pour a made-up client, boards, deals and prices into a
 * workspace that already held real work, where they then turned up in Clients and
 * on Today among the real things.
 */
export async function seedCleanStart(tx, accountId, userId, businessId) {
    const ins = await tx.insert(folders).values({
        accountId, businessId, parentId: null, name: CLEAN_START_FOLDER, pillar: 'operations', position: 0,
        color: '#0ea5e9', createdBy: userId, notes: null,
    });
    await seedBoard(tx, accountId, userId, Number(ins[0].insertId), 'To do', 'Your own jobs: admin, quotes to write, things to chase.', []);
}
//# sourceMappingURL=seed.js.map