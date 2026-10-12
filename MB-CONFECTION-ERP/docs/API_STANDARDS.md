# API Standards

> Status: DRAFT. Backend: PHP REST API (as WorkVoice `api-php`) **TO CONFIRM**.

## General
- Base path: `/api/v1`. JSON only (`Content-Type: application/json; charset=utf-8`).
- Resource-oriented, plural nouns: `/orders`, `/orders/{id}/lines`, `/stock/movements`.
- Methods: `GET` read, `POST` create/action, `PUT/PATCH` update, `DELETE` cancel/soft-delete.
- Non-CRUD actions as sub-resources: `POST /orders/{id}/confirm`, `POST /bundles/{id}/advance`.
- Field names `snake_case`; dates ISO 8601 (`2026-10-06`, `2026-10-06T14:30:00Z`); money as decimal strings or numbers with explicit `currency`.

## Authentication
- `Authorization: Bearer <token>` or secure session cookie; every route declares required permission.
- `401` unauthenticated, `403` forbidden, `404` not found (also for records outside the user's company).

## Response envelope
Success:
```json
{ "data": { }, "meta": { "page": 1, "per_page": 25, "total": 130 } }
```
Error:
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid input", "details": { "quantity": "Must be > 0" } } }
```

## Status codes
`200` OK · `201` Created · `204` No content · `400` Bad request · `401` · `403` · `404` · `409` Conflict (state/version) · `422` Validation · `429` Rate limit · `500` Server error.

## Lists
- Pagination: `?page=1&per_page=25` (max 100).
- Sorting: `?sort=-created_at,order_no`.
- Filtering: `?status=confirmed&customer_id=12&from=2026-01-01&to=2026-03-31`.
- Search: `?q=text`. Export: `?format=csv`.

## Validation & errors
- Validate server-side; return all field errors at once under `details`.
- Stable machine codes: `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`, `INVALID_STATE`, `INSUFFICIENT_STOCK`, `DUPLICATE`.
- Messages safe for display; never leak internals.

## Concurrency & idempotency
- Optimistic locking with `updated_at` or `version`; stale update → `409`.
- Creation endpoints that may be retried (scan/output entry) accept an `Idempotency-Key` header.

## Versioning & docs
- Breaking changes → new version path. Additive changes allowed within a version.
- Maintain an OpenAPI spec (`docs/openapi.yaml`) kept in sync with routes.

## Conventions in code
- Routes in `routes/<module>.php`, shared logic in `lib/services.php`-style services; thin controllers.
- Every route: auth → permission → company scope → validate → execute → audit log → respond.
