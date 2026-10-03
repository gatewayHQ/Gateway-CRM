# Gateway CRM — Design System (`src/components/ui/`)

The shared UI primitives every page builds on. The goal: a page describes
*what* it shows; loading, empty, error, keyboard, screen-reader and phone
behaviour come from here, done once and tested.

```js
import { Button, IconButton, DataTable, DataState, Dialog, Field, Tabs, EmptyState } from '../components/ui'
```

## Architecture

```
src/components/ui/
├── index.js        public surface — import from here, never from the files
├── Icon.jsx        stroke icon set (decorative by default; `label` to make one meaningful)
├── Button.jsx      Button, IconButton
├── Feedback.jsx    Spinner, Skeleton, SkeletonText, EmptyState
├── Field.jsx       label + control + hint + error, wired for assistive tech
├── Dialog.jsx      structured accessible modal
├── Tabs.jsx        WAI-ARIA tabs (Tabs, TabPanel)
├── DataTable.jsx   DataTable, Pagination, DataState
├── dataTable.js    DataTable's rules — pure functions (sort, page, select, view state)
├── Toast.jsx       pushToast(), ToastHost
├── hooks.js        useOverlay, useBackdropDismiss, useMediaQuery, useControllableState
├── layers.js       the overlay stack — pure, no React
└── __tests__/      pure-logic tests (node) + component tests (jsdom, Testing Library)

src/styles/ui.css   component styles; builds on the tokens and base classes in app.css
```

It follows the same layering as the rest of the app (`docs/ARCHITECTURE.md`):
**rules are pure functions** (`dataTable.js`, `layers.js`) that the components
call and the tests exercise directly; **components only render and raise
events**; **nothing here touches Supabase**.

**Legacy `components/UI.jsx`** keeps its exports and props. Its `Modal`,
`Drawer`, `ConfirmDialog`, `Tabs`, `EmptyState` and toasts now run on this
layer, so every existing screen got the accessibility fixes below without a
call-site change. New code imports from `components/ui`.

### Overlays: one stack, one owner of Escape and Tab

Every open `Dialog`, `Modal` and `Drawer` registers on the stack in
`layers.js`. Only the top overlay answers Escape and traps Tab. Ranking: a
modal beats a drawer; an overlay nested inside another's panel beats its
parent; otherwise the most recent wins. Before this, each overlay listened on
`window` for itself, so one Escape closed a confirm *and* the modal under it.

A control inside an overlay that uses Escape itself (an open listbox, an inline
editor) calls `e.preventDefault()`, and the overlay leaves the key alone.
`OptionSelect`, `OptionMultiSelect`, `ChipToggleGroup` and the Data Management
inline editor now do.

`useOverlay` also moves focus into the panel on open (respecting `autoFocus`,
`data-autofocus` or `initialFocusRef`), returns focus to the opener on close,
and locks page scroll with a counter, so overlays closing out of order never
leave the page locked.

## Components

### `Button` / `IconButton`

| Prop | Type | Default | Notes |
|---|---|---|---|
| `variant` | `'primary' \| 'secondary' \| 'ghost' \| 'danger' \| 'link'` | `'secondary'` | Same `.btn--*` classes as hand-written buttons. |
| `size` | `'sm' \| 'md'` | `'md'` | |
| `type` | button type | `'button'` | A bare `<button>` in a form submits it; this one never does by accident. |
| `loading` | bool | `false` | Blocks clicks, `aria-busy`, spinner replaces the icon, width stays put. Uses `aria-disabled`, not `disabled`, so keyboard focus isn't dropped. |
| `loadingText` | node | — | Replaces the label while loading ("Sending…"). |
| `icon` / `iconRight` | icon name | — | |
| `fullWidth` | bool | `false` | |

`IconButton` takes `icon` and a **required** `label`, which is its accessible
name and tooltip. `tone: 'accent' | 'danger'` tints it (the danger tone turns
red only on hover, so a row of trash cans doesn't shout).

```jsx
<Button variant="primary" icon="send" loading={sending} loadingText="Sending…" onClick={send}>Send packet</Button>
<IconButton icon="trash" tone="danger" label={`Delete ${contact.name}`} onClick={() => confirmDelete(contact)} />
```

### `DataTable`

The list view for CRM records.

```jsx
<DataTable
  caption="Properties" noun={{ one: 'property', other: 'properties' }}
  columns={columns} rows={filtered}
  loading={loading} error={error} onRetry={reload}
  filtered={hasFilters} onClearFilters={clearFilters} emptyState={<EmptyState … />}
  sort={sort} onSortChange={setSort} pageResetKey={filterKey}
  onRowClick={open} getRowLabel={p => `Open ${p.address}`}
  rowActions={p => <IconButton icon="edit" label={`Edit ${p.address}`} onClick={() => open(p)} />}
  selectable selectedIds={sel} onSelectionChange={setSel}
  renderBulkActions={(rows, { clear }) => <Button size="sm" onClick={() => assign(rows).then(clear)}>Assign…</Button>}
/>
```

**Column definition**

| Key | Notes |
|---|---|
| `id` | Required, unique. Default value key when there's no `accessor`. |
| `header` | Node shown in the header. |
| `label` | Plain-text name (for the mobile layout, the sort menu and announcements) when `header` isn't a string. |
| `accessor` | Key string or `row => value`. The raw value, used for sorting and the default render. |
| `cell` | `(row, { index }) => node`. Custom render. A blank raw value renders "—" (read aloud as "None"). |
| `sortable`, `sortValue`, `firstSortDir` | `sortValue` when the display value doesn't sort well; `firstSortDir: 'desc'` for money and dates. |
| `rowHeader` | This column names the row: it renders as `<th scope="row">` and, with `onRowClick`, as the row's keyboard-reachable button. Defaults to the first column. Keep its content non-interactive. |
| `align` | `'left' \| 'right' \| 'center'`. Right-align numbers. |
| `width`, `minWidth`, `truncate`, `className`, `headerClassName`, `hidden` | Layout. |
| `mobile` | Card layout: `'secondary'` (subtitle line), `'meta'` (label/value grid; the default) or `'hidden'`. |

**Props**

| Group | Props |
|---|---|
| Data | `columns`, `rows`, `getRowId` (default `r => r.id`), `caption` (`captionHidden` default true), `noun` |
| State | `loading`, `error`, `onRetry`, `filtered`, `onClearFilters`, `emptyState`, `noResultsState` |
| Sort | `sort` / `defaultSort` / `onSortChange` (controlled or not), `manualSort` (rows arrive sorted from the server) |
| Selection | `selectable`, `selectedIds` / `defaultSelectedIds` / `onSelectionChange` (arrays of ids), `renderBulkActions(selectedRows, { clear })` |
| Rows | `onRowClick(row, event)`, `getRowLabel(row)`, `rowActions(row)`, `rowActionsLabel`, `rowClassName(row)` |
| Paging | `pageSize` (default 50; `0` = off), `pageResetKey`, `manualPagination: { page, pageSize, total, onPageChange }` |
| Look | `density: 'comfortable' \| 'compact'`, `layout: 'auto' \| 'table' \| 'cards'`, `mobileBreakpoint` (768), `maxHeight` (enables a sticky header), `skeletonRows` |

**Edge cases it handles, so pages don't have to:**

- **Loading with no rows** shows skeleton rows in the real column layout and announces "Loading properties…". **Loading with rows** keeps them on screen under a thin progress bar.
- **An error with no rows** shows a full-panel error with retry (`role="alert"`). **An error with rows** keeps the last good rows under an error banner; a failed refresh never blanks a list someone is working through.
- **Empty vs. no results:** `filtered` switches the empty panel from "No properties yet" to "No properties match these filters" with Clear filters. Telling someone with 400 listings they have none because a filter matched nothing is a bug.
- **Sorting** is stable, case-insensitive and natural ("Unit 9" before "Unit 10"), puts blanks last in *both* directions, sets `aria-sort` and announces the change.
- **Row clicks** ignore clicks on any control inside the row (buttons, links, inputs, menus, modals rendered in the row) and clicks that end a text selection. Nobody needs `stopPropagation`. Keyboard users open a row through its row-header button.
- **Selection** supports shift-click ranges and a tri-state header checkbox (page-scoped). Ids that leave `rows`, because of a filter or a delete, are **pruned** from the selection, so a bulk action can never hit a record the user can't see.
- **Paging** clamps to the last real page when a filter shrinks the list, resets to page 1 on sort or `pageResetKey` change, announces the new range, and keeps focus on Next/Previous at the ends.
- **Phones** (≤ 768px, or `layout="cards"`) get one card per record (name, subtitle, label/value pairs, actions) plus a "Sort by" select, instead of a sideways-scrolling table.

### `DataState`

DataTable's loading / error / empty / no-results switch for views that aren't
tables (card grids, kanban columns, timelines). It takes the same `loading`,
`error`, `onRetry`, `filtered`, `onClearFilters` and `noun`, plus `count`,
`skeleton`, `empty` and `noResults`. Children render whenever there's
something to show.

### `Dialog`

```jsx
<Dialog open={open} onClose={close} title="Edit contact" eyebrow="Contacts"
        description="Changes save to the shared record." size="md"
        dismissible={!saving}
        footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save</Button></>}>
  …
</Dialog>
```

`size: 'sm' | 'md' | 'lg' | 'xl'` (420/520/720/960px; a bottom sheet on phones),
`role: 'dialog' | 'alertdialog'`, `initialFocusRef`, `hideClose`. While
`dismissible={false}`, Escape, the backdrop and the close button are inert, so
an in-flight save can't be abandoned. The backdrop closes the dialog only on a
click that *started* on it, so drag-selecting text in a field and releasing
outside no longer throws the form away.

### `Field`

```jsx
<Field label="Email" hint="We send the OM here." error={errors.email} required>
  <input className="form-control" type="email" value={email} onChange={…} />
</Field>
```

The child gets `id`, `aria-describedby` (hint + error, merged with its own),
`aria-invalid` and `aria-required`. Pass a function child for composite
controls: `{(fieldProps) => <Picker {...fieldProps} />}`.

### `Tabs` / `TabPanel`

`tabs: [{ id, label, count?, disabled? }]`, `active`, `onChange`, `ariaLabel`,
`idPrefix`. One Tab stop for the strip; ←/→/Home/End move between tabs and skip
disabled ones. Pass `idPrefix` only when you render `<TabPanel idPrefix id active>`
with the same prefix; that's what wires `aria-controls`.

### `EmptyState`

`variant: 'empty' | 'no-results' | 'error'`, `title`, `description` (or the legacy
`message`), `action`, `secondaryAction`, `icon`, `size: 'md' | 'sm'`. The error
variant is `role="alert"`.

### `Spinner`, `Skeleton`, `SkeletonText`

Prefer skeletons for anything with a known shape. The page doesn't jump when
data lands. Skeletons are always `aria-hidden`; the loading region carries
`aria-busy` and one "Loading…" announcement.

### Toasts

`pushToast(message, 'success' | 'error' | 'info', { actionLabel, onAction, duration })`,
the same API as before. Errors are announced assertively and stay 6s by
default; everything else is polite and stays 3s. Each toast keeps its own clock (a new toast
no longer resets the others), pauses while hovered or focused, has a dismiss
button, and at most 4 stack up.

## Conventions and best practices

1. **Reach for the primitive first.** A hand-rolled `<table>`, `<button className="btn">`
   or `<div className="modal-backdrop">` in a new page needs a reason.
2. **Every icon-only control has a name.** Use `IconButton` with a `label` that
   names the target, not just the verb: "Delete 12 Oak St", not "Delete". A
   screen-reader user tabbing through 50 rows hears which one.
3. **Never let a list lie.** Pass `filtered` so an empty filter result says so.
   Pass `error` and `onRetry` so failures are visible. Check `{ error }` from
   every service call before toasting success.
4. **Don't blank what's on screen.** Show refreshes as `loading` with rows still
   present, and refresh failures as `error` with rows still present.
5. **Destructive actions confirm, and focus starts on the safe choice.**
   `ConfirmDialog` does this; give it `busy` so it can't be double-submitted or
   dismissed mid-request.
6. **A control that consumes Escape calls `e.preventDefault()`.** That's the
   contract that keeps the dialog around it open.
7. **Controlled when the page needs the state, uncontrolled otherwise.** Sort,
   selection and tabs all take either form (`value`/`onChange` or `default…`).
8. **Rules go in pure modules, with tests.** If a component grows a decision
   (what to sort by, what's selectable), move it to a `.js` file beside it and
   test it in node. Component behaviour (focus, keys, ARIA) is tested in jsdom
   with `// @vitest-environment jsdom` at the top of a `.test.jsx` file.
9. **Phones are a first-class layout,** not a scrolled-sideways desktop. Give
   columns a `mobile` role; check every new screen at 390px.
10. **Large data:** client-side paging is fine into the low thousands of rows.
    Past that, page on the server with `manualPagination` + `manualSort`, rather
    than virtualising a 50k-row DOM.

## Testing

```bash
npm test                                   # everything
npx vitest run src/components/ui           # the design system
```

## Migration status

- ✅ `Modal`, `Drawer`, `ConfirmDialog`, `Tabs`, `EmptyState`, toasts: upgraded in place (no call-site changes).
- ✅ `pages/properties/PropertiesPage.jsx`: list view on `DataTable`, grid on `DataState`, labelled icon buttons, honest delete.
- ⏭ Next candidates (same pattern): `Leads.jsx`, `Reports.jsx`, `commission/AdminBackOffice.jsx` (hand-rolled `.data-table`), the Contacts list (`.ct-grid`), and `SearchDropdown` → an ARIA combobox.
