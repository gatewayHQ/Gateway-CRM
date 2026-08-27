# Iowa Buyer Agency Packet — BoldSign Selections Spec

Scope: **only** the checkboxes visible in the four screenshots of BoldSign document
`cb4acb7b-ae0c-430e-8f5c-f1edda312a8d` (Appointed Agency Agreement, Agency/Policy
Disclosure, Term of Agreement). Every other checkbox already living on the packet PDF is
out of scope and must not be touched, renamed, or inventoried.

Meaning below is inferred **only** from the printed text next to each box. The BoldSign
field IDs (`CheckBox1`…`CheckBox13`) could not be resolved to boxes — see [UNCERTAIN](#4-uncertain).

---

## 1. Mapping table

| current BoldSign list text | short_label | helper | owner | default | mutex_group | already_set? |
|---|---|---|---|---|---|---|
| *unresolved — see UNCERTAIN* | Exclusive representation | "(exclusive) agency agreement" on the Appointed Agency Agreement | sender locks | **on** (recommended default) | `representation` | no |
| *unresolved — see UNCERTAIN* | Non-exclusive representation | "(non-exclusive) agency agreement" on the same line | sender locks | off | `representation` | no |
| *unresolved — see UNCERTAIN* | Party: Buyer | "prospective BUYER" — the client this packet is for | sender locks (locked **on**) | on | `party` | **yes** |
| *unresolved — see UNCERTAIN* | Party: Seller | "or SELLER" — not used on a buyer packet | sender locks (locked **off**) | off | `party` | no (leave unset) |
| *unresolved — see UNCERTAIN* | Policy: Single Seller Agency | Disclosure item 1 — Brokerage represents the Seller only | sender locks | off (flag if turned on for a buyer packet) | `policy` (non-exclusive set) | no |
| *unresolved — see UNCERTAIN* | Policy: Single Buyer Agency | Disclosure item 2 — Brokerage represents the Buyer only | sender locks | off (optional) | `policy` (non-exclusive set) | no |
| *unresolved — see UNCERTAIN* | Policy: Appointed Agency | Disclosure item 3 — appointed licensee represents the client | locked on | on | `policy` (non-exclusive set) | **yes** |
| *unresolved — see UNCERTAIN* | Policy: Consensual Dual Agency | Disclosure item 4 — appointed agent may represent both sides | locked on | on | `policy` (non-exclusive set) | **yes** |
| *unresolved — see UNCERTAIN* | Term A: Until close / completion | §6.A — runs until closing, completion, or earlier termination | sender locks | **on** (recommended default) | `term` | no |
| *unresolved — see UNCERTAIN* | Term B: Fixed end date | §6.B — ends 11:59 p.m. on a stated date | sender locks | off | `term` | no |
| "this ___ day of ______" (shared text fields, §6) | Term start date | Day / month / year the agreement begins — same value serves A and B | sender fills | empty | — (not a checkbox) | no |
| "this ___ day of ______" (shared text fields, §6.B tail) | Term B end date | Day / month / year the agreement ends, 11:59 p.m. | sender fills **only if Term B** | empty | — (not a checkbox) | no |

**Mutex rules**

- `representation` — **XOR**: exactly one of Exclusive / Non-exclusive. Never both, never neither.
- `term` — **XOR**: exactly one of Term A / Term B ("check either A or B").
- `party` — Buyer on, Seller off, both locked. Not a sender choice on this packet.
- `policy` — *not* mutually exclusive ("check all boxes that apply"). Grouped only for display.
  Policies 3 and 4 are already checked on the live PDF and stay checked. Policy 1 on a buyer
  packet is a contradiction: warn the sender rather than blocking.

---

## 2. Selections panel rewrite

Exact strings to render in place of "CheckboxN · checkbox":

```
Exclusive representation          · sender locks
Non-exclusive representation      · sender locks
Party: Buyer                      · locked on
Party: Seller                     · locked off
Policy: Single Seller Agency      · sender locks (keep off)
Policy: Single Buyer Agency       · sender locks
Policy: Appointed Agency          · locked on
Policy: Consensual Dual Agency    · locked on
Term A: Until close / completion  · sender locks
Term B: Fixed end date            · sender locks
Term start date                   · sender fills
Term B end date                   · sender fills only if B
```

Behavior notes for the panel:

- "sender locks" = the sender sets it here and the value travels with the send, locked; the
  signer cannot change it.
- "locked on" / "locked off" = shown read-only with the current state; no control.
- Selecting one member of a XOR group clears the other member of that group.
- "Term B end date" is disabled until Term B is selected.

---

## 3. Agent checklist

What I still have to pick before Save / Place Fields:

- Exclusive or Non-exclusive
- Term A or Term B
- Dates for the chosen term (start date always; end date only for Term B)

Everything else in these screenshots is already set.

---

## 4. UNCERTAIN

The Selections list in screenshot 1 shows only generic text (`Checkbox1 CheckBox1 · checkbox`),
with no page, position, or nearby-text hint, and the live document could not be read
(`api.boldsign.com` is blocked by this environment's network policy). **No list row can be
matched to a box with confidence, so none is named here.** One question per unmatched row:

1. `CheckBox1` (row 1, "Checkbox1") — which box is this?
2. `CheckBox2` (row 2, "Checkbox1") — which box is this?
3. `CheckBox11` (row 3, "Checkbox2") — which box is this?
4. `CheckBox4` (row 4, "Checkbox1") — which box is this?
5. `CheckBox8` (row 5, "Checkbox1") — which box is this?
6. `CheckBox9` (row 6, "Checkbox2") — which box is this?
7. `CheckBox3` (row 7, "Checkbox1") — which box is this?
8. `CheckBox5` (row 8, "Checkbox1") — which box is this?
9. `CheckBox6` (row 9, "Checkbox1") — which box is this?
10. `CheckBox7` (row 10, "Checkbox2") — which box is this?
11. `CheckBox12` (row 11, "Checkbox1") — which box is this?
12. `CheckBox13` (row 12, "Checkbox2") — which box is this?
13. The list scrolls past row 12 — how many further rows are there, and are any of them among
    the ten boxes above?

Note: the list shows at least 12 checkbox rows while this spec covers 10 boxes, so **at least
two visible rows are out of scope** and must keep their current behavior.

Fastest way to resolve: either allowlist `api.boldsign.com` so the field IDs can be read with
their page coordinates, or click each row in BoldSign and note which box highlights.
