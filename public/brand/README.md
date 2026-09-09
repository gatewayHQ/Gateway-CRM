# Brand assets — The Wolf CRM seal

The seal is referenced from exactly one place in the code: `BrandLogo` in
`src/components/UI.jsx`. Both spots that show it — the boot screen
(`BootScreen`) and the top-left brand slot in the app chrome — render that
component, so changing the artwork is a single edit here plus a rebuild of the
derived sizes.

## Files

| File | Role |
| --- | --- |
| `wolf-crm-logo.jfif` | original artwork, 2048×2048, source of record |
| `wolf-crm-logo-512.png` / `.webp` | boot screen (220px CSS, covers 2x) |
| `wolf-crm-logo-128.png` / `.webp` | header slot (32–36px CSS, covers 3x) |

`BrandLogo` serves the `-128` and `-512` files through a `srcset`/`sizes` pair,
so the browser picks the right one for the slot and the device pixel ratio.

The derived files are **masked to a transparent circle**. The source is a JPEG,
so the seal sits on a flat `#282828` square; shipped as-is that reads as a grey
plate around the circle on the near-black boot screen. With the surround
knocked out, the mark drops onto any background cleanly.

## Regenerating

After replacing `wolf-crm-logo.jfif`:

```sh
npm i -D sharp
node scripts/build-brand-assets.mjs public/brand/wolf-crm-logo.jfif
```

`sharp` is deliberately not a committed dependency — the derived files are
checked in, so nothing in the build or CI needs it. Install it only when you are
regenerating the assets.

The script measures where the gold ring ends rather than assuming a margin, so a
re-export with different padding needs no code change. It prints the radius it
found; a sudden jump there means the new artwork is framed differently and the
output is worth eyeballing.

Rules for the artwork itself:

- Square, uncropped. The circular seal must not touch the edges or be clipped.
- Every size is converted from the original, never from a smaller export.
- Keep the surround a flat colour distinct from the gold, so the edge detection
  can find the ring.
