import { businesses, folders, boards, boardColumns, tasks, deals, offerings } from '../db/schema.js';
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
 * What "Delivery", "Operations" and the first pipeline deal look like depends on what kind
 * of business this is - a services client isn't the same shape as a product order, a
 * software customer, or a piece of content. This is the only thing that changes per type;
 * Acquisition (deals) and Delivery/Operations (folders + boards) stay the same tables and
 * the same three-pillar structure for every type.
 */
const TYPE_CONTENT = {
    services: {
        delivery: {
            folder: 'Sample Client',
            notes: 'An example client to show how Delivery works. Rename it or delete it.',
            board: 'Project Board',
            boardDesc: 'Example board. Rename or delete freely.',
            cards: [
                { title: 'Kick off with your client' },
                { title: 'Do the work' },
                { title: 'Deliver it and capture proof (screenshot, a testimonial)' },
            ],
        },
        operations: { cards: [{ title: 'Set up invoicing and payments' }] },
        deal: { title: 'Your first lead', notes: 'Add real leads here and drag them across the stages as they progress.' },
        offering: { name: 'Website Audit', price: 750, unit: 'project' },
    },
    products: {
        delivery: {
            folder: 'Sample Order',
            notes: 'An example order to show how Delivery works here: fulfillment, not projects. Rename it or delete it.',
            board: 'Fulfillment',
            boardDesc: 'Example order board. Rename or delete freely.',
            cards: [
                { title: 'Order placed and paid' },
                { title: 'Pick, pack and label' },
                { title: 'Ship it and send tracking' },
            ],
        },
        operations: { cards: [{ title: 'Reorder low stock from suppliers' }] },
        deal: { title: 'Your first wholesale lead', notes: 'Add real buyers here and drag them across the stages as they progress.' },
        offering: { name: 'Sample Product', price: 25, cost: 8, unit: 'unit', stockQty: 20, reorderPoint: 5 },
    },
    code: {
        delivery: {
            folder: 'Sample Customer',
            notes: 'An example customer to show how Delivery works here: onboarding, not projects. Rename it or delete it.',
            board: 'Customer Onboarding',
            boardDesc: 'Example board. Rename or delete freely.',
            cards: [
                { title: 'Signed up for a trial' },
                { title: 'Account configured' },
                { title: 'Live and paying' },
            ],
        },
        operations: { cards: [{ title: 'Ship the next feature' }] },
        deal: { title: 'Your first trial signup', notes: 'Add real signups here and drag them across the stages as they convert to paying.' },
        offering: { name: 'Pro Plan', price: 49, unit: 'month', recurring: true },
    },
    content: {
        delivery: {
            folder: 'Sample Piece',
            notes: 'An example piece of content to show how Delivery works here: production, not projects. Rename it or delete it.',
            board: 'Production',
            boardDesc: 'Example board. Rename or delete freely.',
            cards: [
                { title: 'Idea and outline' },
                { title: 'Draft and edit' },
                { title: 'Publish and promote' },
            ],
        },
        operations: { cards: [{ title: 'Maintain equipment and tools' }] },
        deal: { title: 'Your first sponsor', notes: 'Add real sponsors or advertisers here and drag them across the stages as they close.' },
        offering: { name: 'Sponsored Post Slot', price: 500, unit: 'post' },
    },
};
/**
 * Seed a brand-new business with a minimal, fully-deletable starter so it lands on a
 * working three-pillar operating system instead of a blank app. Everything here is
 * ordinary data the owner can rename or delete. Shape of the example content depends on
 * `type`; the underlying folders/boards/deals tables are the same for every type.
 */
export async function seedNewBusiness(tx, accountId, userId, businessId, type) {
    const content = TYPE_CONTENT[type];
    // DELIVERY: one example unit of client-facing work, shaped for this business type.
    const deliveryIns = await tx.insert(folders).values({
        accountId, businessId, parentId: null, name: content.delivery.folder, pillar: 'delivery', position: 0,
        color: '#6366f1', createdBy: userId, notes: content.delivery.notes,
    });
    const deliveryFolderId = Number(deliveryIns[0].insertId);
    await seedBoard(tx, accountId, userId, deliveryFolderId, content.delivery.board, content.delivery.boardDesc, content.delivery.cards);
    // OPERATIONS: the internal machine that keeps the business running. The first card is
    // type-specific; the weekly review and expense tracking are universal to every business.
    const opsIns = await tx.insert(folders).values({
        accountId, businessId, parentId: null, name: 'Operations', pillar: 'operations', position: 0,
        color: '#0ea5e9', createdBy: userId,
        notes: 'Internal work that runs the business, separate from client delivery.',
    });
    const opsFolderId = Number(opsIns[0].insertId);
    await seedBoard(tx, accountId, userId, opsFolderId, 'Internal', 'Admin, finance and the recurring things that keep the business running.', [
        ...content.operations.cards,
        { title: 'Weekly business review', description: 'Check the numbers across all three pillars once a week.' },
        { title: 'Track expenses and admin' },
    ]);
    // ACQUISITION: one example deal so the pipeline is not empty, shaped for this business type.
    await tx.insert(deals).values({
        accountId, businessId, title: content.deal.title, stage: 'lead', value: '0', position: 0,
        notes: content.deal.notes, createdBy: userId,
    });
    // OFFERING: one example of what this business actually sells, shaped for this business type.
    const o = content.offering;
    await tx.insert(offerings).values({
        accountId, businessId, name: o.name, price: String(o.price), position: 0, createdBy: userId,
        cost: o.cost != null ? String(o.cost) : null, unit: o.unit ?? null, recurring: o.recurring ?? false,
        stockQty: o.stockQty ?? null, reorderPoint: o.reorderPoint ?? null,
    });
}
/** Signup: create the account's first business (defaults to services) and seed it. */
export async function seedNewAccount(tx, accountId, userId, businessName = 'My Business', type = 'services') {
    // secondaryTypes written explicitly: a JSON column DEFAULT needs MySQL 8.0.13+,
    // and a strict-mode server rejects an insert that omits a NOT NULL column whose
    // default it will not honour. Signup must not depend on that.
    const bizIns = await tx.insert(businesses).values({
        accountId, name: businessName, type, secondaryTypes: [], position: 0, createdBy: userId,
    });
    const businessId = Number(bizIns[0].insertId);
    await seedNewBusiness(tx, accountId, userId, businessId, type);
}
//# sourceMappingURL=seed.js.map