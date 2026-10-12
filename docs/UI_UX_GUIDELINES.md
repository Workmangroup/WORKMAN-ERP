# UI / UX Guidelines

> Status: DRAFT. Frontend: Next.js + React + Tailwind (as WorkVoice) **TO CONFIRM**.

## Principles
1. **Shop-floor first**: workshop screens usable on a tablet/phone, with gloves-sized touch targets (≥ 44 px) and minimal typing.
2. **Fewer clicks**: common actions (scan bundle, record output, issue stock) in ≤ 3 steps.
3. **Clarity over density** for operators; **density with filters** for managers.
4. **Never lose data**: autosave drafts, confirm destructive actions, show undo where possible.
5. **Consistency**: same patterns across modules.

## Language & locale
- UI default French; English optional. All strings in i18n files, never hard-coded. **TO CONFIRM**
- Dates `DD/MM/YYYY`, numbers `1 234,567`, currency TND with 3 decimals.
- RTL (Arabic) not in v1 but avoid layout choices that block it.

## Layout
- Left sidebar by module (role-filtered), top bar with company, search, user menu.
- List pages: filters + search + sortable columns + pagination + CSV export.
- Detail pages: header (status badge + primary action), tabs for sections, activity/audit timeline.
- Forms: grouped sections, inline validation, required marker, primary button bottom-right.

## Components
- Status badges with consistent colours: draft (gray), confirmed (blue), in progress (amber), done (green), blocked/cancelled (red).
- Size/colour matrix: editable grid with keyboard navigation and totals row/column.
- Barcode scan input always focusable; accepts scanner and manual entry.
- Toasts for success, inline banners for errors, skeleton loaders for lists.

## Dashboards
- Direction: on-time delivery, orders at risk, WIP by stage, efficiency, margin.
- Production: today's output vs target, bundles per stage, defects.
- Stock: low stock alerts, recent movements.
- Each KPI clickable to underlying list.

## Accessibility
- WCAG AA contrast, visible focus, labels on all inputs, no colour-only meaning (add icon/text).

## Performance
- Lists paginated server-side; initial route < 2 s on a mid-range tablet over Wi-Fi.

## Errors & empty states
- Plain-language messages with next action; empty states explain how to create the first record.
