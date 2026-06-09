# Fillable Forms + DocuSign — Admin Guide

How to make a Form Library PDF whose fillable spots **become real DocuSign
fields** — assigned to the right person and pre-filled from the deal — without
rebuilding anything inside DocuSign.

## The short answer
Yes: if you draw fillable fields in the PDF **and name them with the convention
below**, they flow straight into DocuSign. You do **not** need to recreate the
form as a DocuSign template. The app turns on DocuSign's `transformPdfFields`,
which converts your PDF fields into DocuSign tabs, and our naming convention
tells it *who* fills each field and *which* deal value to pre-fill.

## How it works end to end
1. Admin builds a PDF with named fillable fields (Acrobat / any PDF editor).
2. Admin uploads it to the **Form Library** (or it's attached to a deal).
3. Agent opens a deal → **Signatures → Send for Signature**, picks the form, and
   checks **“This is a fillable form.”**
4. On send, the app reads the field names, assigns each field to the matching
   signer (client / co-client / agent), pre-fills the data fields from the deal,
   and sends it through DocuSign with `transformPdfFields` on.
5. Each recipient sees only their own fields; data fields arrive pre-filled and
   editable.

## Easy mode (least typing)
You usually don't need the full `gw_…` name. The app reads the PDF field's own
**type** and infers the rest, so:

- **Signatures / initials / dates:** drop in Acrobat's native **Signature field**
  — no name needed. It becomes the primary client's signature automatically.
- **Checkboxes:** drop a **Check Box** — becomes a client checkbox.
- **Data boxes:** add a **Text Field** and name it after the value, e.g.
  `buyer_name`, `property_address`, `list_price`, `closing_date`. It's assigned
  to the client and pre-filled from the deal.
- **Give it to the agent instead:** prefix the name with `agent_`
  (e.g. `agent_list_price`, or name a signature field `agent_signature`).
- **Second signer (co-buyer/co-seller):** prefix with `client2_` or `co_`.

That's it — most forms need only natural names plus an `agent_`/`client2_` prefix
where the owner isn't the primary client. Use the full convention below only when
you want to be explicit or override the inference.

## The field-naming convention (explicit / advanced)
Name every fillable field like this:

```
gw_<role>_<type>__<key>
```

| Part | Allowed values | Meaning |
|------|----------------|---------|
| `role` | `client`, `client2`, `agent` | Who owns the field. `client` = primary signer (signer 1), `client2` = second signer, `agent` = your agent (only used if the agent is added as a signer). |
| `type` | `sig`, `initial`, `date`, `text`, `check` | The kind of field. |
| `key`  | free text (lowercase, use underscores) | A label. For `text` fields the key also drives **auto-fill** (see table below). |

Note the **double underscore** before the key.

### Examples
```
gw_client_sig__1            → client signature
gw_client_initial__1        → client initials
gw_client_date__1           → client date signed
gw_client_text__buyer_name  → client text box, pre-filled with the buyer's name
gw_agent_text__list_price   → agent text box, pre-filled with the list price
gw_agent_sig__1             → agent signature
gw_client2_sig__1           → co-buyer/co-seller signature
gw_client_check__lead_ack   → client checkbox
```

Any field that doesn't follow this pattern is still converted by DocuSign, but it
won't be auto-assigned to a recipient or pre-filled — so name the ones that matter.

## Auto-fill keys (for `text` fields)
Use these as the `<key>` on a `..._text__<key>` field and the app fills them from
the deal automatically:

| Key | Filled with |
|-----|-------------|
| `buyer_name`, `client_name`, `contact_name` | The deal contact's full name |
| `seller_name` | The deal contact (single-contact deals) |
| `contact_email`, `contact_phone` | Contact email / phone |
| `property_address` | Linked property address |
| `list_price` | Property list price (formatted `$`) |
| `sale_price`, `price` | Deal value (formatted `$`) |
| `deal_title` | Deal title |
| `closing_date`, `inspection_date`, `financing_date`, `appraisal_date`, `possession_date` | The matching **Key Date** on the deal |
| `agent_name`, `agent_email`, `agent_phone` | The sending agent |
| `today` | Today's date |

Unknown keys just produce an empty editable field — fine for things the signer
fills in themselves.

## Building the PDF (Acrobat quick steps)
1. **Tools → Prepare a Form.**
2. Add fields where signatures, initials, dates, and data go.
3. Double-click each field → **Name** → type the `gw_…` name.
   - Use **Text Field** for `text`/`date`, **Check Box** for `check`.
   - For `sig`/`initial`, a Text Field named `gw_client_sig__1` works (DocuSign
     converts it to a sign-here for that recipient); a Digital Signature field
     also works.
4. Save as PDF and upload to the Form Library.

Tip: keep names short and consistent across your state forms so agents get the
same behavior everywhere (e.g. always `gw_client_sig__1`, `gw_agent_sig__1`).

## DocuSign account checklist (do this once)
The fillable-form send uses the same eSignature API as the existing signature
flow, so once the account is configured it "just works." Set these env vars in
Vercel (server-side, **not** `VITE_`-prefixed):

- `DOCUSIGN_INTEGRATION_KEY` (client/integration key)
- `DOCUSIGN_USER_ID` (the API user's GUID)
- `DOCUSIGN_ACCOUNT_ID`
- `DOCUSIGN_PRIVATE_KEY` (RSA private key for JWT grant)
- `DOCUSIGN_AUTH_SERVER` — `account-d.docusign.com` (demo) or `account.docusign.com` (prod)

Then:
1. In the DocuSign admin, grant the integration key **JWT** authorization and
   add the redirect URI, then complete **admin consent** for the API user once.
2. Make sure the API user has access to the account that owns the templates/forms.
3. Configure **DocuSign Connect** to POST envelope status to
   `https://<your-app>/api/docusign` (no `action` field) so completed documents
   flow back into the deal automatically.
4. Test with a demo envelope before pointing at production.

Plan note: the eSignature API + `transformPdfFields` are available on standard
paid plans. You do **not** need the Templates feature for this approach (that's
only required if you choose to rebuild forms inside DocuSign instead).

## When to use a DocuSign Template instead
The PDF-field approach covers the vast majority of forms. Reach for a DocuSign
Template only for a form with complex conditional logic or routing that's easier
to maintain visually in DocuSign. That path can be added later (send by
`templateId`); it's not needed for standard state forms.
