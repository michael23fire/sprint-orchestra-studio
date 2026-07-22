export type AttachmentPreviewKind =
  | 'image'
  | 'pdf'
  | 'text'
  | 'csv'
  | 'spreadsheet'
  | 'unsupported';

export function getAttachmentPreviewKind(
  contentType?: string | null,
  filename?: string | null,
): AttachmentPreviewKind {
  const name = (filename || '').toLowerCase();
  const ct = (contentType || '').toLowerCase();

  if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)) {
    return 'image';
  }
  if (ct.includes('pdf') || name.endsWith('.pdf')) {
    return 'pdf';
  }
  if (ct.includes('csv') || name.endsWith('.csv')) {
    return 'csv';
  }
  if (
    ct.includes('spreadsheetml') ||
    ct.includes('ms-excel') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls')
  ) {
    return 'spreadsheet';
  }
  if (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('markdown') ||
    name.endsWith('.txt') ||
    name.endsWith('.md') ||
    name.endsWith('.log') ||
    name.endsWith('.json') ||
    name.endsWith('.xml')
  ) {
    return 'text';
  }
  return 'unsupported';
}

/** Parse a simple CSV export into rows (handles quoted fields). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && next === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else if (char === '\n' || char === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.length > 1 || row[0] !== '' || rows.length === 0) {
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

export async function readSpreadsheetRows(blob: Blob): Promise<{ sheetName: string; rows: string[][] }> {
  const XLSX = await import('xlsx');
  const buffer = await blob.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0] ?? 'Sheet1';
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' }) as string[][];
  return {
    sheetName,
    rows: rows.map((row) => row.map((cell) => String(cell ?? ''))),
  };
}
