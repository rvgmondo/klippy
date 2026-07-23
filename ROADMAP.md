# Klippy v2 — Roadmap

Rebuild of the Klippy kanban app (originally plain PHP/MySQL, see `../klippy/`) on a
modern, scalable, sellable-SaaS stack. Multi-tenant from day one.

## Stack (decided 2026-07-23)

| Layer      | Choice                                              |
|------------|-----------------------------------------------------|
| Language   | TypeScript (front + back)                            |
| Frontend   | React + Vite + Tailwind + shadcn/ui (static build)  |
| Backend    | Node.js + Fastify (runs as cPanel Node.js app)      |
| Database   | MySQL / MariaDB via Drizzle ORM                      |
| Auth       | JWT in httpOnly cookie, bcrypt password hashing      |
| Billing    | Stripe (later)                                       |
| Deploy     | cPanel: `web/dist` static files + `api` Node app     |

### Why this shape
Shared cPanel hosting can't run Next.js/Vercel reliably. So we split: a **static React
frontend** Apache serves as plain files, and a **small Fastify API** running as the host's
Node.js app, talking to the host's native MySQL. Both halves lift-and-shift to bigger
hardware later with zero rewrite. That is the scalable path for *this* host.

## Multi-tenancy model
Shared-schema. Every domain table carries `account_id` (indexed leftmost). One tenant =
one `accounts` row (a business/workspace). A user belongs to one account. MySQL has no
row-level security, so isolation is enforced in code through a mandatory tenant-scoped
query helper — the boundary can never be forgotten.

## Phases
- [x] 0. Decide stack, set up portable Node toolchain, repo skeleton
- [x] 1. **Foundation**: API scaffold + multi-tenant Drizzle schema + migrations
- [x] 2. Local MariaDB (portable), migrations applied, API boots + serves /health
- [x] 3. Auth: signup (creates account + owner), login, logout, me, JWT cookie + lockout
- [x] 4. Core API: folders (nested tree), boards, columns, tasks (CRUD, tenant-scoped, move/reorder)
- [x] 5. Web app: login/signup, folder-tree sidebar, kanban board w/ drag-to-move, add cards, focus timer
- [x] 6. Feature parity: card detail, subtasks, comments, work timer, dashboard, file attachments (15MB, type allowlist, auth-gated downloads)
- [x] 7. New asks: renameable folder label [done], calendar day/week/month/year [done], focus timer [basic done]
- [x] 7b. Enhancements: precise card drag-ordering, assignees, team/people management,
       workspace-wide search, labels (create/attach/manage), password reset by email
- [ ] 8. Polish: reporting/time-billing, due-date email reminders, mobile
- [ ] 9. Productize: Stripe billing, plans, public signup, landing page
- [~] 10. cPanel deploy: bundle + runbook ready in deploy/ (klippy-web.zip, klippy-api.zip,
       schema.sql, DEPLOY.md). Rebuild any time with `bash scripts/make-deploy.sh`.
       Waiting on: subdomain choice + Ruben's cPanel steps per DEPLOY.md.

## Local dev quickstart
Toolchain is portable, no install: Node at `C:\CC\tools\node`, MariaDB at
`C:\CC\tools\mariadb`. Prepend Node to PATH in each shell:
`export PATH="/c/CC/tools/node:$PATH"` (bash).

1. **Start DB:** `powershell -ExecutionPolicy Bypass -File scripts\dev-db.ps1`
   (MariaDB on 127.0.0.1:3307, db/user/pass all `klippy`).
2. **API:** `cd api && npm install && npm run db:migrate && npm run dev`
   (Fastify on http://127.0.0.1:8090, health at `/api/v1/health`).
3. **Web:** (once scaffolded) `cd web && npm install && npm run dev` (Vite on :5173).

## Feature parity checklist (from v1)
clients-as-folders · boards · custom columns · cards (priority, due, assignee) ·
drag/drop · live timer + manual time entries · subtasks · comments · file attachments ·
roll-up dashboard · team/roles · archive-not-delete.
