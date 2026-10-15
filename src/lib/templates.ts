import type { Env } from '../env'
import { listTemplates, type GraphTemplate, type TemplateComponent } from './meta'

/** A template as the dashboard needs it: which blanks staff must fill in. */
export type TemplateInfo = {
  name: string
  language: string
  category: string
  header: { format: string; text: string | null; vars: string[] } | null
  body: string
  bodyVars: string[]
  footer: string | null
  buttons: Array<{ index: number; type: string; text: string; url: string | null; needsValue: boolean }>
}

/** Keys of `values`: `header.<var>`, `body.<var>`, `headerMedia` (https link), `button.<index>`. */
export type TemplateValues = Record<string, string>

const VAR_RE = /\{\{\s*([\w]+)\s*\}\}/g
const MEDIA_HEADERS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT'])

export function templateVars(text: string | null | undefined): string[] {
  const vars: string[] = []
  for (const m of (text ?? '').matchAll(VAR_RE)) if (!vars.includes(m[1])) vars.push(m[1])
  return vars
}

export function toTemplateInfo(t: GraphTemplate): TemplateInfo {
  const part = (type: string) => t.components?.find((c) => c.type.toUpperCase() === type)
  const header = part('HEADER')
  const body = part('BODY')?.text ?? ''
  const buttons = (part('BUTTONS')?.buttons ?? []).map((b, index) => {
    const type = b.type.toUpperCase()
    return {
      index,
      type,
      text: b.text ?? '',
      url: b.url ?? null,
      needsValue: (type === 'URL' && templateVars(b.url).length > 0) || type === 'COPY_CODE',
    }
  })
  return {
    name: t.name,
    language: t.language,
    category: t.category.toUpperCase(),
    header: header
      ? { format: (header.format ?? 'TEXT').toUpperCase(), text: header.text ?? null, vars: templateVars(header.text) }
      : null,
    body,
    bodyVars: templateVars(body),
    footer: part('FOOTER')?.text ?? null,
    buttons,
  }
}

let cache: { at: number; templates: TemplateInfo[] } | null = null
const CACHE_MS = 5 * 60 * 1000

/** Approved, non-authentication templates (OTP templates carry codes; websites send those). */
export async function getTemplates(
  env: Env,
  refresh = false,
): Promise<{ ok: true; templates: TemplateInfo[] } | { ok: false; status: number; message: string }> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return { ok: true, templates: cache.templates }
  const res = await listTemplates(env)
  if (!res.ok) return res
  const templates = res.templates
    .filter((t) => t.status.toUpperCase() === 'APPROVED' && t.category.toUpperCase() !== 'AUTHENTICATION')
    .map(toTemplateInfo)
    .sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language))
  cache = { at: Date.now(), templates }
  return { ok: true, templates }
}

function param(name: string, text: string) {
  return /^\d+$/.test(name) ? { type: 'text', text } : { type: 'text', parameter_name: name, text }
}

function fill(text: string, values: TemplateValues, prefix: string): string {
  return text.replace(VAR_RE, (_, name: string) => values[`${prefix}.${name}`] ?? `{{${name}}}`)
}

/**
 * Meta `components` for a send plus a readable copy for the transcript.
 * Throws with a staff-friendly message when a blank is missing.
 */
export function buildTemplateMessage(
  t: TemplateInfo,
  values: TemplateValues,
): { components: TemplateComponent[]; preview: string } {
  const need = (key: string, label: string) => {
    const v = values[key]?.trim()
    if (!v) throw new Error(`Fill in ${label}`)
    return v.slice(0, 1024)
  }
  const components: TemplateComponent[] = []

  if (t.header && MEDIA_HEADERS.has(t.header.format)) {
    const link = need('headerMedia', `the ${t.header.format.toLowerCase()} link`)
    if (!/^https:\/\//i.test(link)) throw new Error('The header file link must start with https://')
    const kind = t.header.format.toLowerCase()
    components.push({ type: 'header', parameters: [{ type: kind, [kind]: { link } }] })
  } else if (t.header?.vars.length) {
    components.push({
      type: 'header',
      parameters: t.header.vars.map((v) => param(v, need(`header.${v}`, `header {{${v}}}`))),
    })
  }
  if (t.bodyVars.length) {
    components.push({
      type: 'body',
      parameters: t.bodyVars.map((v) => param(v, need(`body.${v}`, `{{${v}}}`))),
    })
  }
  for (const b of t.buttons) {
    if (!b.needsValue) continue
    const value = need(`button.${b.index}`, `the "${b.text}" button value`)
    components.push(
      b.type === 'COPY_CODE'
        ? { type: 'button', sub_type: 'copy_code', index: String(b.index), parameters: [{ type: 'coupon_code', coupon_code: value }] }
        : { type: 'button', sub_type: 'url', index: String(b.index), parameters: [{ type: 'text', text: value }] },
    )
  }

  const preview = [
    t.header?.format === 'TEXT' && t.header.text ? `*${fill(t.header.text, values, 'header')}*` : null,
    t.header && MEDIA_HEADERS.has(t.header.format) ? `[${t.header.format.toLowerCase()}]` : null,
    fill(t.body, values, 'body'),
    t.footer ? `_${t.footer}_` : null,
    ...t.buttons.map((b) => `[Button: ${b.text}]`),
  ]
    .filter(Boolean)
    .join('\n')
  return { components, preview }
}
