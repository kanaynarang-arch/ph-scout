// The four categories from the case, mapped to Product Hunt topic slugs.
// Verified live on 2026-10-11. If a slug returns nothing, fix it here.
export type CategoryId = "project-management" | "hr-tech" | "developer-productivity" | "team-communication";

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

export function categoriesForSlugs(slugs: string[]): CategoryId[] {
  const set = new Set(slugs);
  return CATEGORIES.filter((c) => c.slugs.some((s) => set.has(s))).map((c) => c.id);
}

export function categoryLabel(id: CategoryId): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}
