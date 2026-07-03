import { attachmentApi, type IssueAttachmentDto } from '../api';

export type PendingAttachment = {
  pendingId: string;
  file: File;
  objectUrl: string;
  originalFilename: string;
  contentType: string;
};

export function createPendingAttachment(file: File): PendingAttachment {
  return {
    pendingId: crypto.randomUUID(),
    file,
    objectUrl: URL.createObjectURL(file),
    originalFilename: file.name,
    contentType: file.type || 'application/octet-stream',
  };
}

export function revokePendingMap(pending: Map<string, PendingAttachment>) {
  pending.forEach((p) => URL.revokeObjectURL(p.objectUrl));
  pending.clear();
}

export function collectPendingIdsFromHtml(html: string): string[] {
  const container = document.createElement('div');
  container.innerHTML = html;
  const ids: string[] = [];
  container.querySelectorAll('[data-pending-attachment-id]').forEach((el) => {
    const id = el.getAttribute('data-pending-attachment-id');
    if (id) ids.push(id);
  });
  return ids;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function insertPendingAttachmentAtCursor(editor: HTMLDivElement, pending: PendingAttachment) {
  const isImage = pending.contentType.startsWith('image/');
  const pendingAttr = `data-pending-attachment-id="${pending.pendingId}"`;
  const nameAttr = `data-attachment-name="${escapeHtml(pending.originalFilename)}"`;
  const html = isImage
    ? `<p><img ${pendingAttr} ${nameAttr} src="${escapeHtml(pending.objectUrl)}" alt="${escapeHtml(pending.originalFilename)}" /></p><p><br></p>`
    : `<p><span ${pendingAttr} ${nameAttr}>[file] ${escapeHtml(pending.originalFilename)}</span></p><p><br></p>`;
  editor.focus();
  editor.ownerDocument.execCommand('insertHTML', false, html);
}

type ResolvedPending = {
  attachmentId: number;
  originalFilename: string;
  contentType: string;
};

function replacePendingInHtml(html: string, resolved: Map<string, ResolvedPending>): string {
  const container = document.createElement('div');
  container.innerHTML = html;
  container.querySelectorAll('[data-pending-attachment-id]').forEach((el) => {
    const pendingId = el.getAttribute('data-pending-attachment-id');
    if (!pendingId) return;
    const info = resolved.get(pendingId);
    if (!info) return;
    el.removeAttribute('data-pending-attachment-id');
    el.setAttribute('data-attachment-id', String(info.attachmentId));
    el.setAttribute('data-attachment-name', info.originalFilename);
    if (el.tagName === 'IMG') {
      el.removeAttribute('src');
      el.classList.add('ticket-rich-image');
    }
  });
  return container.innerHTML;
}

/** Uploads staged files still referenced in HTML; revokes blob URLs for uploaded pendings. */
export async function finalizeEditorHtmlWithUploads(
  issueDbId: number,
  html: string,
  pending: Map<string, PendingAttachment>,
): Promise<{ html: string; uploaded: IssueAttachmentDto[] }> {
  const pendingIds = [...new Set(collectPendingIdsFromHtml(html))];
  const resolved = new Map<string, ResolvedPending>();
  const uploaded: IssueAttachmentDto[] = [];

  for (const pendingId of pendingIds) {
    const entry = pending.get(pendingId);
    if (!entry) continue;
    const created = await attachmentApi.upload(issueDbId, entry.file, { embedded: true });
    uploaded.push(created);
    resolved.set(pendingId, {
      attachmentId: created.id,
      originalFilename: created.originalFilename,
      contentType: created.contentType ?? entry.contentType,
    });
    URL.revokeObjectURL(entry.objectUrl);
    pending.delete(pendingId);
  }

  return { html: replacePendingInHtml(html, resolved), uploaded };
}
