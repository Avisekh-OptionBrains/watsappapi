const OPT_OUT_RE = /^(stop|unsubscribe|opt[\s-]?out|cancel)\b/i
const OPT_IN_RE = /^(start|subscribe|opt[\s-]?in)\b/i

export type WhatsAppCrmKind = 'opt_out' | 'opt_in' | 'message'

/** Classify a customer WhatsApp text for the OptionBrains CRM. */
export function classifyWhatsAppCrmKind(text: string): WhatsAppCrmKind {
  if (OPT_OUT_RE.test(text)) return 'opt_out'
  // Exact "subscribe" is left as a normal message; START / opt in record consent.
  if (OPT_IN_RE.test(text) && !/^subscribe$/i.test(text.trim())) return 'opt_in'
  return 'message'
}
