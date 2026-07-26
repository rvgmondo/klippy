import { db } from '../db/client.js';
import { businesses, folders, boards, boardColumns, tasks, deals } from '../db/schema.js';

// The drizzle transaction handle, typed straight off db.transaction so inserts stay type-safe.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const COLUMNS = [
  { name: 'To do', color: '#94a3b8', isDoneColumn: false },
  { name: 'Doing', color: '#3b82f6', isDoneColumn: false },
  { name: 'Done', color: '#22c55e', isDoneColumn: true },
];

interface SeedCard { title: string; description?: string; column?: number }

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
 * Seed a brand-new workspace with a minimal, universal, fully-deletable starter so a new
 * business, freelancer or startup lands on a working three-pillar operating system instead
 * of a blank app. Everything here is ordinary data the owner can rename or delete.
 */
export async function seedNewAccount(tx: Tx, accountId: number, userId: number, businessName = 'My Business') {
  // The account's first business; everything seeded below belongs to it.
  const bizIns = await tx.insert(businesses).values({
    accountId, name: businessName, position: 0, createdBy: userId,
  });
  const businessId = Number(bizIns[0].insertId);

  // DELIVERY: a sample client with a project board.
  const deliveryIns = await tx.insert(folders).values({
    accountId, businessId, parentId: null, name: 'Sample Client', pillar: 'delivery', position: 0,
    color: '#6366f1', createdBy: userId,
    notes: 'An example client to show how Delivery works. Rename it or delete it.',
  });
  const deliveryFolderId = Number(deliveryIns[0].insertId);
  await seedBoard(tx, accountId, userId, deliveryFolderId, 'Project Board',
    'Example board. Rename or delete freely.', [
      { title: 'Kick off with your client', column: 0 },
      { title: 'Do the work', column: 0 },
      { title: 'Deliver it and capture proof (screenshot, a testimonial)', column: 0 },
    ]);

  // OPERATIONS: the internal machine that keeps the business running.
  const opsIns = await tx.insert(folders).values({
    accountId, businessId, parentId: null, name: 'Operations', pillar: 'operations', position: 0,
    color: '#0ea5e9', createdBy: userId,
    notes: 'Internal work that runs the business, separate from client delivery.',
  });
  const opsFolderId = Number(opsIns[0].insertId);
  await seedBoard(tx, accountId, userId, opsFolderId, 'Internal',
    'Admin, finance, hiring and the recurring things that keep the lights on.', [
      { title: 'Set up invoicing and payments', column: 0 },
      { title: 'Weekly business review', description: 'Check the numbers across all three pillars once a week.', column: 0 },
      { title: 'Track expenses and admin', column: 0 },
    ]);

  // ACQUISITION: one example deal so the pipeline is not empty.
  await tx.insert(deals).values({
    accountId, businessId, title: 'Your first lead', stage: 'lead', value: '0', position: 0,
    notes: 'Add real leads here and drag them across the stages as they progress.',
    createdBy: userId,
  });
}
