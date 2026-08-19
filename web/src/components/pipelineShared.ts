/**
 * Shapes the pipeline screens agree on. Shared rather than duplicated, so the deal
 * editor and the board cannot drift apart on what a deal is.
 */
export type Stage = 'lead' | 'contacted' | 'proposal' | 'won' | 'lost';
export interface Deal {
  id: number; title: string; company: string | null; contactName: string | null;
  contactEmail: string | null; contactPhone: string | null; value: string;
  stage: Stage; notes: string | null; clientFolderId: number | null;
  contactId?: number | null; source?: string | null;
  nextFollowUpAt?: string | null; followUpNote?: string | null;
}
export interface Contact { id: number; name: string; email: string | null; company: string | null }
export interface Activity {
  id: number; kind: 'note' | 'call' | 'email' | 'meeting' | 'stage';
  body: string | null; occurredAt: string;
}
export interface Summary {
  openCount: number; pipelineValue: number; wonThisMonth: number; wonValueThisMonth: number;
  wonCount: number; lostCount: number; winRate: number | null;
  bySource: { source: string; deals: number; won: number; wonValue: number }[];
  lostReasons: { reason: string; count: number }[];
}
