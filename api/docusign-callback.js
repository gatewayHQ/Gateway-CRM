// DocuSign OAuth redirect URI — only hit during the one-time JWT consent step.
// The code param in the query string is intentionally ignored; JWT auth never
// uses it. This endpoint just needs to exist and return 200 so DocuSign has a
// valid URI to register and redirect to after the admin clicks "Allow".
export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/html')
  res.status(200).send(`<!doctype html><html><head><title>DocuSign Connected</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb}
.box{text-align:center;padding:40px;border-radius:12px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h2{margin:0 0 8px;color:#111827}p{margin:0;color:#6b7280;font-size:14px}</style></head>
<body><div class="box"><h2>&#10003; DocuSign Connected</h2>
<p>You can close this tab and return to Gateway CRM.</p></div></body></html>`)
}
