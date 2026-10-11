// The four categories from the case are built in and always scanned. EXTRA_CATEGORIES are optional: Kavya can switch up to
// MAX_EXTRAS of them on, they are never scanned by default, and only these ids are ever accepted from the page.
// Each category maps to Product Hunt topic slugs. Verified live on 2026-10-12. If a slug returns nothing, fix it here.
export type CoreCategoryId = "project-management" | "hr-tech" | "developer-productivity" | "team-communication";
export type ExtraCategoryId = "sales" | "marketing" | "analytics" | "ai-tools";
export type CategoryId = CoreCategoryId | ExtraCategoryId;

export interface Category {
  id: CategoryId;
  label: string;
  slugs: string[];
}

export const CATEGORIES: Category[] = [
  { id: "project-management", label: "Project management", slugs: ["task-management"] },
  { id: "hr-tech", label: "HR tech", slugs: ["human-resources", "hiring"] },
  { id: "developer-productivity", label: "Developer productivity", slugs: ["developer-tools", "productivity"] },
  { id: "team-communication", label: "Team communication", slugs: ["meetings"] },
];

export const EXTRA_CATEGORIES: Category[] = [
  { id: "sales", label: "Sales tools", slugs: ["sales"] },
  { id: "marketing", label: "Marketing tools", slugs: ["marketing"] },
  { id: "analytics", label: "Analytics", slugs: ["analytics"] },
  { id: "ai-tools", label: "AI tools", slugs: ["artificial-intelligence"] },
];

export const ALL_CATEGORIES: Category[] = [...CATEGORIES, ...EXTRA_CATEGORIES];
export const MAX_EXTRAS = 2; // each extra costs Product Hunt API budget, so only a few at a time

/** Keeps only known extra ids, removes duplicates, keeps the menu order and caps the count. Anything else is dropped. */
export function parseExtras(v: unknown): ExtraCategoryId[] {
  if (!Array.isArray(v)) return [];
  const wanted = new Set(v.filter((x): x is string => typeof x === "string"));
  return EXTRA_CATEGORIES.filter((c) => wanted.has(c.id)).slice(0, MAX_EXTRAS).map((c) => c.id as ExtraCategoryId);
}

/** The four built-in categories plus the chosen extras: what one run scans. */
export function scannedCategories(extras: readonly ExtraCategoryId[] = []): Category[] {
  return [...CATEGORIES, ...EXTRA_CATEGORIES.filter((c) => (extras as readonly string[]).includes(c.id))];
}

/** Tags only the categories that were actually scanned, so a launch is never tagged with a category that was switched off. */
export function categoriesForSlugs(slugs: string[], scanned: Category[] = CATEGORIES): CategoryId[] {
  const set = new Set(slugs);
  return scanned.filter((c) => c.slugs.some((s) => set.has(s))).map((c) => c.id);
}

export function categoryLabel(id: CategoryId): string {
  return ALL_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}
