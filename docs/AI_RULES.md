# AI Rules (for Claude Code and other coding assistants)

> Read this file and the other docs in `docs/` before changing code.

## Source of truth
1. `BUSINESS_RULES.md` and `DATABASE_SCHEMA.md` define behaviour and data. If code and docs disagree, **ask** — don't silently pick one.
2. Items marked **TO CONFIRM** are unvalidated: do not hard-code them as final; make them configurable or ask.

## Workflow
- Understand first: read related files and docs before editing.
- Make the smallest change that solves the task; no unrelated refactors.
- Match existing style, naming and structure (PHP routes in `routes/`, services in `lib/`, Next.js pages in `src/app`).
- Update the relevant doc in `docs/` in the same change when behaviour, schema, roles or API change.
- Ask before: destructive DB changes, dropping data, adding heavy dependencies, changing auth/security.

## Stack conventions **TO CONFIRM**
- Backend: PHP REST API, MySQL, migrations as new numbered SQL files (never edit applied ones).
- Frontend: Next.js (App Router) + TypeScript + Tailwind.
- Data access via a single API client in the frontend (`lib/api.ts`); no ad-hoc fetch calls in components.

## Must-follow rules
- Security checklist in `SECURITY_RULES.md` applies to every endpoint: auth, permission, `company_id` scope, parameterized SQL, validation, audit log.
- Stock changes only through `stock_movements`; never update a stock total directly.
- No hard deletes of business data; use status/soft delete.
- Money/quantity use DECIMAL, never float.
- No secrets in code or commits; only `*.example` config files.
- All user-facing strings go through i18n (French default).

## Code quality
- Typed, readable, small functions; comments only where intent isn't obvious.
- Validate at boundaries (API input), trust internal calls.
- Add or update tests for business rules (reference rule IDs, e.g. `BR-STK-002`).
- Run lint/type-check/tests before declaring a task done; report failures honestly.

## Communication
- State assumptions explicitly. If requirements are ambiguous, list options with a recommendation.
- Summarize what changed and what was **not** verified.
- Never fabricate data, endpoints or business rules; propose and mark as **TO CONFIRM**.
