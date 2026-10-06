// The sender for the CRM's own Resend mail (lead alerts, landing-page alerts,
// the signed copy). RESEND_FROM overrides it; without it every mailer uses the
// same firm address rather than some sending and others silently skipping.
export const DEFAULT_RESEND_FROM = 'Gateway CRM <noreply@gatewayreadvisors.com>'

export const resendFrom = () => process.env.RESEND_FROM || DEFAULT_RESEND_FROM
