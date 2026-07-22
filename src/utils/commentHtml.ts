/** Escape text for safe HTML insertion. */
export function escapeCommentHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function containsHtmlMarkup(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value) || /&(?:[a-z]+|#\d+|#x[\da-f]+);/i.test(value);
}

/** Turn plain text blocks into paragraph HTML with preserved line breaks. */
export function plainTextToCommentHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((line) => escapeCommentHtml(line.trim())).filter(Boolean);
      if (lines.length === 0) return '';
      if (lines.length === 1) return `<p>${lines[0]}</p>`;
      return `<p>${lines.join('<br>')}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Seed data and legacy comments sometimes store plain text with `\n` followed by
 * an HTML attachment block. Browsers collapse those newlines when rendered as HTML.
 */
export function prepareCommentHtmlForDisplay(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  if (!containsHtmlMarkup(trimmed)) return plainTextToCommentHtml(trimmed);

  const firstTag = trimmed.search(/<\/?[a-z]/i);
  if (firstTag < 0) return plainTextToCommentHtml(trimmed);
  if (firstTag === 0) return trimmed;

  const prefix = trimmed.slice(0, firstTag).trim();
  const htmlPart = trimmed.slice(firstTag);
  if (!prefix) return htmlPart;
  return `${plainTextToCommentHtml(prefix)}\n${htmlPart}`;
}

export function normalizeAttachmentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}._-]/gu, '');
}

export type AttachmentLookup = {
  id: number;
  originalFilename: string;
  contentType?: string | null;
};

export function findAttachmentByName<T extends AttachmentLookup>(
  attachments: T[] | undefined,
  name: string,
): T | undefined {
  const raw = name.trim().toLowerCase();
  const normalized = normalizeAttachmentName(name);
  return (attachments ?? []).find((attachment) => {
    const fileRaw = attachment.originalFilename.trim().toLowerCase();
    if (fileRaw === raw) return true;
    return normalizeAttachmentName(attachment.originalFilename) === normalized;
  });
}

export function findAttachmentById<T extends AttachmentLookup>(
  attachments: T[] | undefined,
  id: number | string | null | undefined,
): T | undefined {
  if (id === null || id === undefined || id === '') return undefined;
  const numId = typeof id === 'string' ? Number(id) : id;
  if (!Number.isFinite(numId)) return undefined;
  return (attachments ?? []).find((attachment) => attachment.id === numId);
}

export function resolveAttachmentFromElement<T extends AttachmentLookup>(
  attachments: T[] | undefined,
  el: Element,
): T | undefined {
  const idAttr = el.getAttribute('data-attachment-id');
  const nameAttr = el.getAttribute('data-attachment-name');
  return findAttachmentById(attachments, idAttr) ?? (nameAttr ? findAttachmentByName(attachments, nameAttr) : undefined);
}
