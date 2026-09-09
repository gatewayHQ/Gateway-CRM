# Brand assets — The Wolf CRM seal

The seal is referenced from exactly one place in the code: `BrandLogo` in
`src/components/UI.jsx`. Both spots that show it — the boot screen
(`BootScreen`) and the top-left brand slot in the app chrome — render that
component, so changing the artwork is a single edit here plus a rebuild of the
derived sizes.

## Files this folder must contain

| File | Used by |
| --- | --- |
| `wolf-crm-logo.jfif` | original artwork, kept as the source of record (not served) |
| `wolf-crm-logo.png` / `.webp` | 1024px master |
| `wolf-crm-logo-512.png` / `.webp` | boot screen (220px CSS, covers 2x) |
| `wolf-crm-logo-128.png` / `.webp` | header slot (32–36px CSS, covers 3x) |

`BrandLogo` serves the `-128` and `-512` files through a `srcset`/`sizes` pair,
so the browser picks the right one for the slot and the device pixel ratio.

## Regenerating

Drop the original square seal in this folder as `wolf-crm-logo.jfif`, then:

```sh
npm i -D sharp
node scripts/build-brand-assets.mjs public/brand/wolf-crm-logo.jfif
```

Rules for the artwork itself:

- Square, uncropped. The circular seal must not touch the edges or be clipped.
- Convert from the original once per size — never upscale a small export.
- Keep the charcoal field (`#0b0b0b`, exposed as `--gw-seal-field`) or make it
  transparent. Anything lighter shows as a grey halo around the circle.
