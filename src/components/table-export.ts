/** A rendered table's cells, header row first, as the reader sees them. */
export function tableRows(table: HTMLTableElement): string[][] {
  return [...table.rows].map(row => [...row.cells].map(cell => (cell.textContent ?? "").replace(/\s+/g, " ").trim()));
}
/** Rows as a GitHub-flavored Markdown table. The first row is the header. */
export function tableToMarkdown(rows: string[][]) {
  if (!rows.length) return "";
  const width = Math.max(...rows.map(row => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => (row[index] ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}
/**
 * Rows as RFC 4180 CSV with CRLF line ends, quoting only cells that need it. A reply can repeat web
 * content, so a cell a spreadsheet would run as a formula gets a leading apostrophe; numbers stay numbers.
 */
export function tableToCsv(rows: string[][]) {
  const inert = (value: string) => /^[=+@\t\r]/.test(value) || /^-(?![\d.,\s]*$)/.test(value) ? `'${value}` : value;
  const cell = (raw: string) => {
    const value = inert(raw);
    return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  return rows.map(row => row.map(cell).join(",")).join("\r\n");
}
