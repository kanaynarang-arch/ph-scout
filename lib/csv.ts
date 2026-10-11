import type { ScoredLaunch } from "./types";

// Client-side CSV export of the rows currently visible on the page. Only data already on the page.

export const CSV_HEADER = [
  "rank",
  "product name",
  "founder(s)",
  "one-line description",
  "upvotes",
  "maker comments",
  "days since launch",
  "score",
  "provisional",
  "fit",
  "outreach angle",
  "evidence quote",
  "launch URL",
] as const;

type Cell = string | number | null | undefined;

/** Spreadsheet formula-injection guard: a text cell starting with = + - @ (or tab / CR) gets a leading apostrophe. */
export function neutraliseFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** RFC 4180 quoting: wrap in quotes when the cell has a comma, quote, CR or LF; double inner quotes. */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" ? String(value) : neutraliseFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: Cell[]): string {
  return cells.map(csvCell).join(",");
}

const FIT_LABEL: Record<ScoredLaunch["ai"]["fit"], string> = {
  strong: "Strong fit",
  possible: "Possible fit",
  weak: "Weak fit",
  competitor: "Likely competitor",
  unrated: "Not rated",
};

export function founderText(f: ScoredLaunch["founders"]): string {
  if (f.names.length) return f.names.join("; ") + (f.hiddenCount > 0 ? ` (+${f.hiddenCount} hidden)` : "");
  if (f.hunter) return `${f.hunter} (hunter, may not be the founder)`;
  return "Not available";
}

export interface CsvRow {
  rank: number | null; // null = not ranked (Too early to rank)
  launch: ScoredLaunch;
}

export function rowToCells({ rank, launch: r }: CsvRow): Cell[] {
  return [
    rank,
    r.name,
    founderText(r.founders),
    r.ai.oneLiner,
    r.votesHidden ? "votes hidden" : r.votesCount,
    r.makerComments === null ? "not counted" : r.makerComments,
    r.daysSinceLaunch,
    r.votesHidden ? "" : r.score.toFixed(1),
    r.votesHidden ? "" : r.provisional ? "yes" : "no",
    FIT_LABEL[r.ai.fit],
    r.ai.angle,
    r.ai.quoteStatus === "none" ? "" : (r.ai.evidenceQuote ?? ""),
    r.url,
  ];
}

/** CSV text (CRLF line endings) for the given rows, in the given order. */
export function toCsv(rows: CsvRow[]): string {
  return [csvLine([...CSV_HEADER]), ...rows.map((r) => csvLine(rowToCells(r)))].join("\r\n") + "\r\n";
}
