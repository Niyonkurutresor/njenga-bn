import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';

/**
 * Rich-text report bodies (the in-app "Word-like" editor) are stored as HTML.
 * Everything that comes from the browser is sanitised against this allow-list before it is
 * saved, so a report can never carry scripts, event handlers, iframes or external styles.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'mark',
    'sub',
    'sup',
    'code',
    'pre',
    'blockquote',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'colgroup',
    'col',
    'a',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    th: ['colspan', 'rowspan', 'colwidth'],
    td: ['colspan', 'rowspan', 'colwidth'],
    col: ['style'],
    p: ['style'],
    h1: ['style'],
    h2: ['style'],
    h3: ['style'],
    h4: ['style'],
    ol: ['start'],
  },
  allowedStyles: {
    '*': { 'text-align': [/^(left|right|center|justify)$/] },
    col: { width: [/^\d+px$/], 'min-width': [/^\d+px$/] },
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }),
  },
};

/** Maximum size of one rich-text body (stored in MEDIUMTEXT; stays well under the 1 MB JSON body limit). */
export const RICH_TEXT_MAX_LENGTH = 500_000;

export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, OPTIONS).trim();
}

/** Plain text version, for search, notifications, SMS and spreadsheet/PDF exports. */
export function richTextToPlain(html: string | null | undefined): string {
  if (!html) return '';
  const withBreaks = html
    .replace(/<\/(p|h[1-4]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t');
  return sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when the editor content has no visible text (e.g. "<p></p>"). */
export function isRichTextEmpty(html: string | null | undefined): boolean {
  return richTextToPlain(html).length === 0;
}

/**
 * Zod field for a rich-text body. Plain text (older clients, offline drafts) is accepted too;
 * the output is always sanitised HTML.
 */
type RichTextOptions = { required?: boolean; label?: string };
type OptionalRichText = z.ZodType<string | null | undefined, string | null | undefined>;

function richTextBase(label: string) {
  return z
    .string()
    .max(RICH_TEXT_MAX_LENGTH, `${label} is too long`)
    .transform((v) => sanitizeRichText(v));
}

/** Required: must contain visible text; output is a sanitised HTML string. */
export function richText(opts: { required: true; label?: string }): z.ZodType<string, string>;
/** Optional: empty editor content becomes `null`. */
export function richText(opts?: { required?: false; label?: string }): OptionalRichText;
export function richText(opts?: RichTextOptions): z.ZodType<string, string> | OptionalRichText;
export function richText(opts: RichTextOptions = {}): z.ZodType<string, string> | OptionalRichText {
  const label = opts.label ?? 'This field';
  return opts.required
    ? richTextBase(label).refine((v) => !isRichTextEmpty(v), `${label} is required`)
    : richTextBase(label)
        .transform((v) => (isRichTextEmpty(v) ? null : v))
        .nullish();
}
