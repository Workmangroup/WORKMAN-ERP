# Modules

> Status: DRAFT. Priority: P1 = MVP, P2 = next, P3 = later.

| # | Module | Priority | Summary |
|---|---|---|---|
| 1 | Auth & Administration | P1 | Users, roles, permissions, company settings, numbering, audit log |
| 2 | Master Data | P1 | Customers, suppliers, materials, sizes/colours, units, warehouses |
| 3 | Models & Technical Sheets | P1 | Model versions, BOM, operations sequence, standard times |
| 4 | Sales & Orders | P1 | Quotes, orders, size/colour matrix, amendments, delivery dates |
| 5 | Purchasing | P2 | Purchase orders, goods receipts, supplier tracking |
| 6 | Stock | P1 | Lots/rolls, movements, reservations, inventory, alerts |
| 7 | Production | P1 | Production orders, cutting, bundles, stage tracking, output entry |
| 8 | Quality | P2 | Inspections (incoming/inline/final), defects, rework |
| 9 | Costing | P2 | Model cost, actual vs standard, margin analysis |
| 10 | Workforce & Piece-rate | P2 | Employees, attendance, piece-rate, payroll inputs |
| 11 | HR Self-service (WorkVoice) | P2 | Leave, lateness, exits, attestations, complaints — reuse WorkVoice |
| 12 | Shipping & Invoicing | P2 | Packing lists, shipments, invoices, credit notes, payments |
| 13 | Reporting & Dashboards | P1/P2 | Direction, production, stock, quality KPIs, CSV/PDF export |
| 14 | Maintenance (machines) | P3 | Machine registry, preventive maintenance, downtime |
| 15 | Mobile/Scanner app | P3 | Barcode scanning, offline output entry |

## Module dependencies
Master Data → Models → Orders → Production → Quality → Shipping/Invoicing.
Stock feeds Production (issue) and Purchasing (receipt). Workforce feeds Production (output per operator).

## Per-module deliverables
Each module ships with: DB migration, API routes, frontend pages, permissions, audit logging, seed data, and tests.

## Reuse from WorkVoice
Auth, multi-tenant layer, HR self-service (leave/lateness/exits/attestations), PDF generation, CSV export, app shell. **TO CONFIRM** whether integrated or kept separate.
