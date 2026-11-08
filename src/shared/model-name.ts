/**
 * A readable name for a model slug, with no lookup. Ported from T3 Code's `formatModelSlugName` in
 * packages/shared/src/model.ts (MIT, Copyright (c) 2026 T3 Tools Inc.):
 * `claude-opus-5-5` becomes "Claude Opus 5.5" and `gpt-6.1-terra` becomes "GPT-6.1-Terra".
 * A slug of any other family comes back unchanged, so a custom model is never mangled.
 */
export function formatModelSlugName(slug: string): string {
  const separator = slug.lastIndexOf('/') + 1;
  const prefix = slug.slice(0, separator);
  const name = slug.slice(separator);
  if (/^gpt-\d/i.test(name)) return prefix + name.replace(/^gpt/i, 'GPT').replace(/-([a-z])/g, (_, c: string) => '-' + c.toUpperCase());
  if (!/^(claude-(opus|sonnet|haiku|fable)|gemini|grok|composer)-\d/i.test(name)) return slug;
  return prefix + name
    .replace(/^(claude-[a-z]+-\d+)-(\d{1,2})(?=-|\[|$)/i, '$1.$2')
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
