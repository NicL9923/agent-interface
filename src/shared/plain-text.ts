/**
 * Plain words from Markdown, read by a real Markdown parser rather than patterns, so code,
 * identifiers like __init__, link titles and literal punctuation come out as people wrote them.
 * The server imports this directly. The web client loads it only when saving a reply, so the
 * parser stays out of the main bundle.
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes, Root, RootContent } from "mdast";

/**
 * Text parsed. Previews, titles and snippets need far less, and the parser's worst cases
 * (alternating * and _, deeply nested lists or quotes) stay under 50 ms at this size. A message
 * whose first READ_CHARS characters are code therefore previews as that code: reaching the words
 * after it would mean parsing far more, or a second pass that rebuilds Markdown, and both cost more
 * than they save.
 */
const READ_CHARS = 2000;
/** Inline nodes join their children directly; everything else is a block that stands apart. */
const inline = new Set(["paragraph", "heading", "emphasis", "strong", "delete", "link", "linkReference", "tableCell"]);
/** Blocks that are never the words of a title. */
const unread = new Set(["code", "html", "thematicBreak", "definition", "footnoteDefinition", "yaml"]);

/** Markdown read up to READ_CHARS. `cut` says the caller already shortened it, so its end may be partial. */
function parse(markdown: string, cut = false): Root {
  const text = markdown.slice(0, READ_CHARS * 2).replace(/\r\n?/g, "\n");
  let read = text;
  if (cut || text.length > READ_CHARS) {
    // Long text is cut at its last blank line within the limit, so a link or table cut halfway
    // never shows its raw Markdown. Only one paragraph past the limit is cut mid-way.
    const head = text.slice(0, READ_CHARS);
    let blank = -1;
    for (const match of head.matchAll(/\n[ \t]*\n/g)) blank = match.index;
    read = blank > 0 ? head.slice(0, blank) : head;
  }
  return fromMarkdown(read, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** A node's words. Code counts only when asked, as a reply that is nothing but code still says something. */
function words(node: Nodes, code: boolean): string {
  switch (node.type) {
    case "text": case "inlineCode": return node.value;
    case "code": return code ? node.value : "";
    case "image": case "imageReference": return node.alt ?? "";
    case "break": return " ";
    case "html": case "thematicBreak": case "definition": case "footnoteDefinition": case "yaml": return "";
    case "table": return node.children.map(row => cells(row, code)).filter(Boolean).join(" · ");
  }
  if (!("children" in node)) return "";
  const parts = (node.children as RootContent[]).map(child => words(child, code));
  return inline.has(node.type) ? parts.join("") : parts.filter(Boolean).join(" ");
}

const cells = (row: Nodes, code: boolean) => "children" in row ? (row.children as RootContent[]).map(cell => words(cell, code).trim()).filter(Boolean).join(" · ") : "";
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** One line of plain text from Markdown. A message of only code, fenced, indented or quoted, keeps that code. */
export function markdownPlain(markdown: string, cut = false): string {
  const root = parse(markdown, cut);
  return oneLine(words(root, false)) || oneLine(words(root, true));
}

/**
 * A Hermes search snippet as plain words that keep its >>>match<<< markers, so every client marks
 * the same words. A snippet can quote stored JSON, so its escaped line breaks become real ones.
 */
export function snippetPlain(snippet: string): string {
  // The markers stand in as private-use characters while parsing, so the input's own are removed first.
  // Each pattern matches one escape at a time, so a long run of backslashes is read once.
  // Entity spellings of them, which the parser would decode, are removed too.
  const text = snippet.slice(0, READ_CHARS * 2).replace(/[\uE000\uE001]|&#(?:x0*e00[01]|0*5734[45]);/gi, "")
    .replace(/\\n/g, "\n").replace(/\\[rt]/g, " ").replace(/\\"/g, '"')
    .replaceAll(">>>", "\uE000").replaceAll("<<<", "\uE001");
  // A snippet cut above may end inside a block, whatever length the markers leave it.
  return markdownPlain(text, snippet.length > READ_CHARS * 2)
    .replaceAll("\uE000", ">>>").replaceAll("\uE001", "<<<");
}

/** The first block a person reads, looking inside lists and quotes. */
function firstBlock(nodes: RootContent[]): RootContent | undefined {
  for (const node of nodes) {
    if (unread.has(node.type)) continue;
    if (node.type === "list" || node.type === "listItem" || node.type === "blockquote") {
      const inner = firstBlock(node.children as RootContent[]);
      if (inner) return inner;
    } else if (oneLine(words(node, false))) return node;
  }
  return undefined;
}

/** A saved reply's title: the first line a person reads in it, cut at a word. */
export function replyTitle(markdown: string): string {
  const first = firstBlock(parse(markdown).children);
  // A table is titled by its header row; other text by its first line.
  const text = first?.type === "table" ? cells(first.children[0], false) : first ? words(first, false) : "";
  const title = text.split("\n").map(oneLine).find(Boolean);
  if (!title) return "Saved reply";
  const characters = Array.from(title);
  if (characters.length <= 80) return title;
  const prefix = characters.slice(0, 79).join("");
  const boundary = prefix.lastIndexOf(" ");
  return (boundary > 0 ? prefix.slice(0, boundary) : prefix) + "…";
}
