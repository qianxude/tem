/**
 * Simple table renderer for CLI output
 */

export interface TableColumn {
  header: string;
  key: string;
  width?: number;
  align?: 'left' | 'right';
}

export interface TableRow {
  [key: string]: string | number | null;
}

/**
 * Calculate the display width of a string (accounting for ANSI codes)
 */
function displayWidth(str: string): number {
  // Strip ANSI escape codes
  const clean = str.replace(/\u001b\[[0-9;]*m/g, '');
  return clean.length;
}

/**
 * Pad a string to a specific width
 */
function pad(str: string, width: number, align: 'left' | 'right' = 'left'): string {
  const strWidth = displayWidth(str);
  if (strWidth >= width) {
    return str;
  }
  const padding = ' '.repeat(width - strWidth);
  return align === 'left' ? str + padding : padding + str;
}

/**
 * Truncate a string to fit within a width
 */
function truncate(str: string, width: number): string {
  const strWidth = displayWidth(str);
  if (strWidth <= width) {
    return str;
  }
  if (width <= 3) {
    return '.'.repeat(width);
  }
  return str.slice(0, width - 3) + '...';
}

/**
 * Render a table to string
 */
export function renderTable(columns: TableColumn[], rows: TableRow[]): string {
  if (rows.length === 0) {
    return '';
  }

  // Calculate column widths
  const colWidths = columns.map((col) => {
    const headerWidth = displayWidth(col.header);
    const dataWidths = rows.map((row) => {
      const value = row[col.key];
      return displayWidth(String(value ?? '-'));
    });
    const maxWidth = Math.max(headerWidth, ...dataWidths);
    return Math.min(maxWidth, col.width ?? maxWidth);
  });

  const lines: string[] = [];

  // Header row
  const headerRow = columns
    .map((col, i) => pad(col.header, colWidths[i], col.align))
    .join('  ');
  lines.push(headerRow);

  // Separator
  lines.push(colWidths.map((w) => '-'.repeat(w)).join('  '));

  // Data rows
  for (const row of rows) {
    const rowStr = columns
      .map((col, i) => {
        const value = String(row[col.key] ?? '-');
        const truncated = truncate(value, colWidths[i]);
        return pad(truncated, colWidths[i], col.align);
      })
      .join('  ');
    lines.push(rowStr);
  }

  return lines.join('\n');
}

/**
 * Render a simple key-value table
 */
export function renderKeyValue(
  data: Array<{ key: string; value: string | number | null }>,
  keyWidth?: number
): string {
  if (data.length === 0) {
    return '';
  }

  const maxKeyWidth =
    keyWidth ?? Math.max(...data.map((d) => displayWidth(d.key)));

  const lines = data.map(({ key, value }) => {
    const paddedKey = pad(key + ':', maxKeyWidth + 1);
    return `${paddedKey} ${value ?? '-'}`;
  });

  return lines.join('\n');
}
