/**
 * Hermes's clarify tool marks the first of several choices with this suffix (tools/clarify_tool.py
 * RECOMMENDED_LABEL) and strips it again from the answer it receives, comparing without case.
 * The raw option stays the value a client sends; only the label drops the suffix.
 */
const SUFFIX = "(recommended)";

/** The option's label without a trailing "(Recommended)", or undefined when it has none or nothing else is left. */
export function withoutRecommendation(option: string): string | undefined {
  const trimmed = option.trim();
  if (!trimmed.toLowerCase().endsWith(SUFFIX)) return undefined;
  return trimmed.slice(0, -SUFFIX.length).trim() || undefined;
}

/** The one recommended option's index. Several marked options are ambiguous, so none is recommended. */
export function recommendedOption(options: readonly string[] | undefined): number | undefined {
  const marked = (options ?? []).flatMap((option, index) => withoutRecommendation(option) === undefined ? [] : [index]);
  return marked.length === 1 ? marked[0] : undefined;
}

/** What a question's option reads as: the recommended one loses its suffix, which a tag shows instead. */
export function optionLabel(question: { options?: string[]; recommended?: number }, index: number): string {
  const option = question.options?.[index] ?? "";
  return index === question.recommended ? withoutRecommendation(option) ?? option : option;
}
