# Security Rules

> Status: DRAFT. Baseline for all code and AI-generated code.

## Authentication
- Passwords hashed with `password_hash` (bcrypt/argon2); never stored or logged in clear.
- Session via secure, HttpOnly, SameSite cookies or short-lived JWT + refresh; logout invalidates server-side.
- Login rate limiting and lockout/backoff after repeated failures.
- Password policy: min 10 chars; reset by one-time expiring token.

## Authorization
- Every endpoint checks authentication **and** role/permission server-side (see `USER_ROLES.md`).
- Every query on business data is scoped by `company_id` taken from the session, never from client input.
- Object-level checks: user may only access records they are allowed to see (IDOR prevention).

## Input & output
- Validate and sanitize all input server-side (type, length, range, enum).
- Prepared statements / parameter binding only; **no string-concatenated SQL**.
- Escape output; React escaping by default, never `dangerouslySetInnerHTML` with user data.
- File uploads: whitelist type/extension, size limit, random filenames, store outside web root, scan if possible.

## Transport & headers
- HTTPS only, HSTS. CORS restricted to known origins.
- CSRF protection on cookie-authenticated state-changing requests.
- Security headers: CSP, X-Content-Type-Options, X-Frame-Options/frame-ancestors, Referrer-Policy.

## Secrets & config
- No secrets in the repo. Use `config.php` (git-ignored) / env vars; commit only `config.example.php`.
- Separate dev/staging/prod credentials; least-privilege DB user.

## Data protection
- Sensitive data (salaries, ID numbers) restricted by role; mask in lists and logs.
- Backups daily, encrypted, restore tested regularly. **TO CONFIRM** retention.
- Comply with Tunisian personal-data law (INPDP). **TO CONFIRM**

## Audit & logging
- Audit log for create/update/delete/status change/login/permission change (who, when, IP, before/after).
- Application errors logged server-side; never expose stack traces to clients.
- Audit logs are append-only.

## Dependencies & operations
- Pin dependencies; review updates; run `npm audit` / `composer audit` regularly.
- Principle: deny by default; fail closed.

## Checklist before merge
- [ ] Auth + permission check on new endpoints
- [ ] `company_id` scoping
- [ ] Parameterized queries
- [ ] Input validation
- [ ] Audit log where required
- [ ] No secrets committed
