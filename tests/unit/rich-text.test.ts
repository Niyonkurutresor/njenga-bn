import { describe, expect, it } from 'vitest';
import {
  isRichTextEmpty,
  richText,
  richTextToPlain,
  sanitizeRichText,
} from '../../src/common/utils/rich-text.js';

describe('rich text', () => {
  it('strips scripts, event handlers and unknown tags', () => {
    const out = sanitizeRichText(
      '<p onclick="x()">Hi<script>alert(1)</script><img src=x onerror=y></p><iframe src="e"></iframe>',
    );
    expect(out).toBe('<p>Hi</p>');
  });

  it('keeps report formatting: headings, lists, tables, alignment', () => {
    const html =
      '<h2 style="text-align:center">Week 3</h2><ul><li><p>Done</p></li></ul><table><tbody><tr><td>a</td></tr></tbody></table>';
    expect(sanitizeRichText(html)).toBe(html);
  });

  it('rejects javascript: links and forces safe link attributes', () => {
    expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
  });

  it('converts to readable plain text', () => {
    expect(
      richTextToPlain('<h2>Title</h2><p>Line &amp; more</p><ul><li>a</li><li>b</li></ul>'),
    ).toBe('Title\nLine & more\na\nb');
  });

  it('treats an empty editor as empty', () => {
    expect(isRichTextEmpty('<p></p>')).toBe(true);
    expect(isRichTextEmpty('<p> </p><p><br></p>')).toBe(true);
    expect(isRichTextEmpty('<p>x</p>')).toBe(false);
  });

  it('zod field: required vs optional', () => {
    expect(richText({ required: true }).safeParse('<p></p>').success).toBe(false);
    expect(richText().parse('<p></p>')).toBeNull();
    expect(richText().parse('plain text')).toBe('plain text');
  });
});
