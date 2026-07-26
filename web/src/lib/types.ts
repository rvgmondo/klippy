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
export interface Business {
  id: number;
  accountId: number;
  name: string;
  color: string;
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
