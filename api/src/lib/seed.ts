import { db } from '../db/client.js';
import { businesses, folders, boards, boardColumns, tasks, deals, offerings } from '../db/schema.js';
import { TEMPLATES, type BusinessType, type SeedCard } from './templates.js';

// The drizzle transaction handle, typed straight off db.transaction so inserts stay type-safe.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];


const COLUMNS = [
  { name: 'To do', color: '#94a3b8', isDoneColumn: false },
  { name: 'Doing', color: '#3b82f6', isDoneColumn: false },
  { name: 'Done', color: '#22c55e', isDoneColumn: true },
];


// Create a board (with the default 3 columns) under a folder, plus optional starter cards.
async function seedBoard(
  tx: Tx, accountId: number, userId: number,
  folderId: number, name: string, description: string, cards: SeedCard[],
) {
  const boardIns = await tx.insert(boards).values({
    accountId, folderId, name, description, position: 0, createdBy: userId,
  });
  const boardId = Number(boardIns[0].insertId);

  const colIds: number[] = [];
  for (let i = 0; i < COLUMNS.length; i++) {
    const c = COLUMNS[i]!;
    const ins = await tx.insert(boardColumns).values({
      accountId, boardId, name: c.name, color: c.color, isDoneColumn: c.isDoneColumn, position: i,
    });
    colIds.push(Number(ins[0].insertId));
  }

  // Group starter cards by their target column so positions stay clean per column.
  const perColumn: Record<number, number> = {};
  for (const card of cards) {
    const colIdx = card.column ?? 0;
    const position = perColumn[colIdx] ?? 0;
    perColumn[colIdx] = position + 1;
    await tx.insert(tasks).values({
      accountId, boardId, columnId: colIds[colIdx]!,
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
export async function seedNewBusiness(
  tx: Tx, accountId: number, userId: number, businessId: number, type: BusinessType,
) {
  const t = TEMPLATES[type];

  // DELIVERY then OPERATIONS. Position counts per pillar, since the sidebar groups them.
  for (const [pillar, group] of [['delivery', t.delivery], ['operations', t.operations]] as const) {
    for (let i = 0; i < group.length; i++) {
      const area = group[i]!;
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
    const d = t.deals[i]!;
    await tx.insert(deals).values({
      accountId, businessId, title: d.title, company: d.company ?? null,
      stage: d.stage, value: String(d.value), position: i, notes: d.notes, createdBy: userId,
    });
  }

  // What this business sells, which is what makes Reports and invoicing meaningful.
  for (let i = 0; i < t.offerings.length; i++) {
    const o = t.offerings[i]!;
    await tx.insert(offerings).values({
      accountId, businessId, name: o.name, price: String(o.price), position: i, createdBy: userId,
      cost: o.cost != null ? String(o.cost) : null, unit: o.unit ?? null, recurring: o.recurring ?? false,
      stockQty: o.stockQty ?? null, reorderPoint: o.reorderPoint ?? null,
    });
  }
}

/** Signup: create the account's first business (defaults to services) and seed it. */
export async function seedNewAccount(
  tx: Tx, accountId: number, userId: number, businessName = 'My Business',
  type: BusinessType = 'services', modules: string[] | null = null,
) {
  // secondaryTypes written explicitly: a JSON column DEFAULT needs MySQL 8.0.13+,
  // and a strict-mode server rejects an insert that omits a NOT NULL column whose
  // default it will not honour. Signup must not depend on that.
  const bizIns = await tx.insert(businesses).values({
    accountId, name: businessName, type, secondaryTypes: [], position: 0, createdBy: userId,
    // The blueprint's module set, when signup chose one; null keeps the type default.
    modules,
  });
  const businessId = Number(bizIns[0].insertId);
  await seedNewBusiness(tx, accountId, userId, businessId, type);
}
