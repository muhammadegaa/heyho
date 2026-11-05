import type { Tag } from './types';

const TAG_MAX = 32;

export function tagSlug(name: string): string {
  const plain = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  let slug = plain.toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '');
  slug = slug.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > TAG_MAX) {
    slug = slug.slice(0, TAG_MAX).replace(/-+$/, '');
  }
  if (!slug) {
    throw new Error(`tag "${name}" has no letters or digits`);
  }
  return slug;
}

/** Turn free-text tag names into unique tags, keeping the first spelling of each. */
export function normalizeTags(names: readonly string[]): Tag[] {
  const bySlug = new Map<string, Tag>();
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const slug = tagSlug(name);
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, name });
  }
  return [...bySlug.values()];
}
