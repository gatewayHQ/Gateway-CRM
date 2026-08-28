# Iowa Buyer Agency Packet — BoldSign Selections Spec

Scope: **only** the checkboxes visible in the four reviewed screenshots of BoldSign document
`cb4acb7b-ae0c-430e-8f5c-f1edda312a8d` (Appointed Agency Agreement, Agency/Policy Disclosure,
Term of Agreement). Every other checkbox on the packet is out of scope and must not be touched,
renamed, or inventoried.

Meaning comes only from the printed text next to each box. Field identity comes from the filled
packet PDF's signing summary joined to the Selections list — see [Method](#method) for what that
join proves and where it stops.

**Update — the residue this doc left open is now resolvable without guessing.** Every checkbox
carries `bounds`, and BoldSign measures them from the top-left of the page, so page + y + x is
reading order. The send screen and `npm run selections:spec` both list tick boxes that way now
(see [Resolving the pairs](#4-resolving-the-pairs)), which means the two boxes of a pair no longer
arrive in an unknown order: the one that prints on the left of the line is the one listed first.
The pairs below are still written as `A|B` because the ordered list has not been run against the
live template from here — the network policy for this session blocks `api.boldsign.com`. Running
it is a one-command job for anyone whose machine can reach BoldSign.

---

## What the packet actually contains

The template carries **14 checkbox fields**. The Selections list shows 12 without scrolling;
2 more sit below the fold. Ten of the fourteen are on pages you did not screenshot.

| Doc page | Form | Checkbox fields | In scope? |
|---|---|---|---|
| 1 | Appointed Agency Agreement | 3 (Buyer role) | **yes** — screenshot 2 |
| 2 | Term of Agreement §6 | 2 (one Buyer, one Buyer's Agent) | **yes** — screenshot 4 |
| 3 | — | 1 (Agent) | no |
| 4 | Agency/Policy Disclosure p.1 | 4 (Agent role) | **yes** — screenshot 3 |
| 9 | — | 2 (Buyer) — **both already ON** | no |
| 10 | — | 2 (Agent) | no |

---

## 1. Mapping table

`field_id` is the id shown in grey in the Selections list. A `A|B` pair means the two boxes are
identified as a pair but their order within the page is not resolved — see
[Resolving the pairs](#4-resolving-the-pairs).

| current BoldSign list text | field_id | short_label | helper | owner | default | mutex_group | already_set? |
|---|---|---|---|---|---|---|---|
| `Checkbox1 · CheckBox1` / `Checkbox2 · CheckBox11` | `CheckBox1` \| `CheckBox11` | Exclusive representation | "(exclusive)" on the opening line, p.1 | sender locks | **on** (recommended default) | `representation` | no (off) |
| `Checkbox1 · CheckBox1` / `Checkbox2 · CheckBox11` | `CheckBox11` \| `CheckBox1` | Non-exclusive representation | "(non-exclusive)", same line | sender locks | off | `representation` | no (off) |
| `Checkbox1 · CheckBox2` | `CheckBox2` | Party: Buyer | "prospective BUYER" — confirmed by the printed X at 95.5pt on p.1 | locked on | on | `party` | **yes** |
| *(no field — see question 1)* | — | Party: Seller | "or SELLER" — printed box, no BoldSign field found | n/a | stays blank | `party` | no |
| *(to be replaced — see Term A/B as Labels)* | new Label, replaces `CheckBox4`/`CheckBox3` | Term A: Until close / completion | §6.A — runs until closing, completion, or earlier termination | sender fills (**Label**) | `X` (recommended default) | `term` | no |
| *(to be replaced — see Term A/B as Labels)* | new Label, replaces `CheckBox4`/`CheckBox3` | Term B: Fixed end date | §6.B — ends 11:59 p.m. on a stated date | sender fills (**Label**) | empty | `term` | no |
| `Checkbox1 · CheckBox12` / `Checkbox2 · CheckBox13` | `CheckBox12` \| `CheckBox13` | Policy: Single Seller Agency | Disclosure item 1 | sender locks | off — flag if turned on | `policy` (not exclusive) | no (off) |
| `Checkbox1 · CheckBox12` / `Checkbox2 · CheckBox13` | `CheckBox13` \| `CheckBox12` | Policy: Single Buyer Agency | Disclosure item 2 | sender locks | off (optional) | `policy` (not exclusive) | no (off) |
| `Checkbox1 · CheckBox6` / `Checkbox2 · CheckBox7` | `CheckBox6` \| `CheckBox7` | Policy: Appointed Agency | Disclosure item 3 | locked on | on | `policy` (not exclusive) | **yes** |
| `Checkbox1 · CheckBox6` / `Checkbox2 · CheckBox7` | `CheckBox7` \| `CheckBox6` | Policy: Consensual Dual Agency | Disclosure item 4 | locked on | on | `policy` (not exclusive) | **yes** |
| "this ___ day of ______" (p.2 Labels) | — | Term start date | Day / month / year the agreement begins — one value serves A and B | sender fills | empty | — | no |
| "this ___ day of ______" (p.2 Labels, §6.B tail) | — | Term B end date | Day / month / year it ends, 11:59 p.m. | sender fills **only if B** | empty | — | no |

**List rows that are NOT screenshot boxes — leave them alone:** `CheckBox8` and `CheckBox9`
(p.9, **both already ticked**), `CheckBox5` (p.3), and the two rows below the scroll fold (p.10).

**Mutex rules**

- `representation` — **XOR**: exactly one of Exclusive / Non-exclusive. Never both, never neither.
- `term` — **XOR**: exactly one of Term A / Term B ("check either A or B"). Enforced by the
  CRM, not by BoldSign: the chosen term's Label carries `X` and the other is sent empty.
- `party` — Buyer is ticked and stays ticked. Seller appears to have no field at all.
- `policy` — *not* mutually exclusive ("check all boxes that apply"); grouped only for display.
  Policies 3 and 4 are ticked and stay ticked. Policy 1 on a buyer packet is a contradiction:
  warn the sender rather than blocking.

---

## 2. Selections panel rewrite

Exact strings to render in place of "CheckboxN · checkbox":

```
Exclusive representation          · sender locks
Non-exclusive representation      · sender locks
Party: Buyer                      · locked on
Policy: Single Seller Agency      · sender locks (keep off)
Policy: Single Buyer Agency       · sender locks
Policy: Appointed Agency          · locked on
Policy: Consensual Dual Agency    · locked on
```

The term choice is **not** in this panel. Once Term A/B become Labels they are shared fields, so
they belong with the other values every signer reads on arrival:

```
Term: which one          · A — until close / completion   (default)
                         · B — fixed end date
Term start date          · sender fills
Term B end date          · sender fills only if B
```

"Party: Seller · locked off" is **dropped from the panel**: no checkbox field was found on that
box, so there is nothing to lock. It stays blank on the printed form, which is the desired
outcome anyway.

Behavior notes:

- "sender locks" — the sender sets it here and the value travels with the send, locked.
- "locked on" — shown read-only in its current state; no control.
- Selecting one member of a XOR group clears the other.
- "Term B end date" is disabled until Term B is selected.

---

## 3. Agent checklist

What I still have to pick before Save / Place Fields:

- Exclusive or Non-exclusive
- Term A or Term B
- Dates for the chosen term (start always; end date only for Term B)

Everything else in these screenshots is already set.

---

## 4. Resolving the pairs

Three questions remain (see below). Each is a **pair whose two members are identified but whose
order within the page is not** — the ordering that used to survive into the Selections list was
BoldSign's field creation order, and on page 4 that order is provably *not* the visual
top-to-bottom order (the two ticked policies, 3 and 4, come first in the list even though 1 and 2
print above them).

**How to settle all three without clicking each row in the BoldSign editor** — either
Form Library → edit this packet → **Download selections spec** (admin-only; the server
holds the key, so nothing is copied anywhere), or from a shell:

```
BOLDSIGN_API_KEY=… npm run selections:spec
```

It writes `docs/boldsign-selections/<template>.md` per template, listing every tick box in the
order it prints — page, then line, then left to right — with its id, role, current ticked state,
and the boxes that share its line. Read it beside the packet and each question below answers
itself: the first row of the "(exclusive) … (non-exclusive)" line is the box printed on the left,
which is `(exclusive)`. The same ordering now drives the send screen's Selections list, so an
agent who never opens this file still sees the boxes in the order the paper has them.

What the command does **not** do is name a box. The words printed beside a box are not in the API
payload, so `short_label` comes out as TODO — deliberately, because a generated name that is
plausible and wrong is the failure this whole exercise exists to prevent. Order comes from the
API; meaning comes from the printed page; a person joins them once per template.

1. **Page 1 — is `SELLER` a field?** Page 1 has four printed boxes (exclusive, non-exclusive,
   BUYER, SELLER) but only three checkbox fields. `CheckBox2` is BUYER (confirmed). Are the
   other two on *exclusive* and *non-exclusive* — or does one of them sit on SELLER, leaving
   one representation box unfillable?
2. **Page 1 — `CheckBox1` vs `CheckBox11`:** which is Exclusive and which is Non-exclusive?
   Consequence of guessing: the packet says the opposite of what the agent picked.
3. ~~**Page 2 — `CheckBox4` vs `CheckBox3`:** which is Term A and which is Term B?~~
   **Resolved by removal** — both are being replaced by Labels placed directly on the §6.A and
   §6.B boxes, so their current order stops mattering. Three questions remain, not four.
4. **Page 4 — `CheckBox12` vs `CheckBox13`:** which is Policy 1 (Single Seller Agency, must stay
   off) and which is Policy 2 (Single Buyer Agency, optional)?
   (`CheckBox6` vs `CheckBox7` — Policies 3 and 4 — is the same open pair, but both are locked
   on, so the order does not change behavior.)

---

## Term A/B as Labels

A Label is not a checkbox — it is read-only text whose value is set at send time and which **every
signer sees the moment the document arrives**, in any signing order. So "make Term A/B Labels" is
not a type change on the existing fields; it is:

1. **Delete** `CheckBox4` (Buyer role) and `CheckBox3` (Buyer's Agent role) from the template.
2. **Place two Labels** in the same spots — one inside the §6.A box, one inside the §6.B box.
3. **Name them** so the CRM can address them, e.g. `term_a_mark` and `term_b_mark`. A field's
   *name* is what a CRM token matches; its *id* stays BoldSign's auto-counter.
4. At send time the CRM writes `X` into the chosen term's Label and an **empty string** into the
   other. That is what makes the XOR real: one value written, one blank, both decided in one place.

Why this beats simply moving both checkboxes onto one role, which would also fix the visibility bug:

- A Label is read-only **by construction** — no signer can alter the term after the sender sets it.
  A read-only CheckBox is read-only only for the role it is assigned to.
- Every party reads the term on arrival, whatever the signing order. This is the exact case the
  Label field exists for, per `docs/boldsign-integration.md`.
- A signer cannot tick one box while the other is blank — a state a printed either/or agreement
  must never reach.

Placement note: size each Label to the printed square so the `X` lands inside it rather than
beside it. Nothing else on page 2 changes — the three date groups stay as they are.

---

## Two defects found while mapping

Neither is in scope to fix here; both affect whether this packet behaves correctly when sent.

1. **Term A and Term B are assigned to different signers.** `CheckBox4` sits on the Buyer role
   and `CheckBox3` on the Buyer's Agent role. Per `docs/boldsign-integration.md`, a CheckBox is
   role-scoped: each signer sees only their own box until the other has signed. Neither party can
   see both halves of an either/or choice, and the XOR cannot be enforced or even observed by one
   signer.

   **Decision: both become Labels.** See [Term A/B as Labels](#term-ab-as-labels) for the
   mechanics.
2. ~~**The signing summary prints `f.label`, not `f.id`.**~~ **Fixed.** `buildSigningSummary()`
   in `api/boldsign.js` now carries the field id and prints it for any box with no caption of its
   own, and orders each page's fields by position rather than by type name. The printed copy and
   the Selections list can be joined row for row, without the reconstruction in [Method](#method).

---

## Method

How the field ids above were established, so the next person can check the work rather than
trust it:

- The four uploaded packet PDFs are **flattened** — `/AcroForm` present but zero fields and zero
  annotations — so the form field names are not recoverable from the page objects.
- The CRM's own print route appends a **signing summary** listing every field by page, type,
  label, and value. That gave the page, role, and current state of all 14 checkboxes.
- `buildSigningSummary()` sorts rows by page with a **stable** sort, so relative order *within* a
  page is the raw BoldSign order. `templateDetails` in `api/boldsign.js` builds its field list by
  iterating roles and pushing each role's `formFields`, so the Selections list carries that same
  role-grouped order.
- The label sequence of the summary's 14 checkboxes matches the Selections list's visible 12
  exactly, including at position 6, where role-grouped order and raw page order disagree. That
  match is what licenses the row-by-row join.
- Page identity was confirmed by rendering pages 1, 2, and 4 and reading them: Appointed Agency
  Agreement, Term of Agreement §6, Agency/Policy Disclosure p.1 of 3. The printed X marks land on
  BUYER (p.1, 95.5pt — matching the one ticked field) and on Policies 3 and 4 (p.4).

What this does **not** establish: the order of two same-page fields sharing a state. That is
exactly the residue in [Resolving the pairs](#4-resolving-the-pairs), and it is why no id above is
asserted where a coin flip would decide it.

**What established it since**: `bounds`. The join above worked from list order, which is placement
order; the field's own coordinates were there the whole time and were simply not being carried to
the screen. `template-details` now returns `page` and `bounds`, `orderFieldsByPosition()` in
`src/lib/services/boldsignFields.js` sorts by them, and both the send screen and the spec
generator read the packet the way a person does. Everything above stands; the part that needed a
click no longer does.
