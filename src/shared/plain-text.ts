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
 * Text parsed after fenced code is set aside. Previews, titles and snippets need far less, and
 * the parser's worst case (alternating * and _) stays near 35 ms at this size.
 */
const READ_CHARS = 2000;
/** Inline nodes join their children directly; everything else is a block that stands apart. */
const inline = new Set(["paragraph", "heading", "emphasis", "strong", "delete", "link", "linkReference", "tableCell"]);

function parse(text: string): Root {
  // Long text is cut at its last paragraph break within the limit, so a link or table cut
  // halfway never shows its raw Markdown. Only a single paragraph past the limit is cut mid-way.
  const cut = text.length > READ_CHARS ? text.slice(0, READ_CHARS) : text;
  const paragraph = cut === text ? -1 : cut.lastIndexOf("\n\n");
  return fromMarkdown(paragraph > 0 ? cut.slice(0, paragraph) : cut, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/**
 * Markdown with its top-level fenced code blocks set aside, line by line in one pass, so a long
 * block can't push the words after it past what is parsed. The first block's code is kept for a
 * reply that is nothing but code.
 */
function splitFences(markdown: string): { prose: string; code: string } {
  const prose: string[] = [], code: string[] = [];
  let fence: { char: string; size: number } | null = null, blocks = 0;
  for (const line of markdown.split("\n")) {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && mark && !(mark[0] === "`" && line.slice(line.indexOf(mark) + mark.length).includes("`"))) {
      fence = { char: mark[0], size: mark.length }; blocks++;
    } else if (fence && mark && mark[0] === fence.char && mark.length >= fence.size && !line.trim().slice(mark.length).trim()) fence = null;
    else if (fence) { if (blocks === 1) code.push(line); }
    else prose.push(line);
  }
  return { prose: prose.join("\n"), code: code.join("\n") };
}

/** A node's words. Code blocks count only when asked, as a reply that is nothing but code still says something. */
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

/** One line of plain text from Markdown. A message of only code keeps that code rather than reading as empty. */
export function markdownPlain(markdown: string): string {
  const { prose, code } = splitFences(markdown);
  return oneLine(words(parse(prose), false)) || oneLine(code.slice(0, READ_CHARS));
}

/**
 * Hermes search marks matches >>>like this<<<, and a snippet can quote stored JSON. The markers
 * survive flattening, so every client marks the same words.
 */
export function snippetPlain(snippet: string): string {
  // Escaped line breaks become real ones, so a quoted list or heading still reads as one.
  // Each pattern matches one escape at a time, so a long run of backslashes is read once.
  const text = snippet.slice(0, READ_CHARS).replace(/\\n/g, "\n").replace(/\\[rt]/g, " ").replace(/\\"/g, '"')
    .replaceAll(">>>", "\uE000").replaceAll("<<<", "\uE001");
  return markdownPlain(text).replaceAll("\uE000", ">>>").replaceAll("\uE001", "<<<");
}

const unread = new Set(["code", "html", "thematicBreak", "definition", "footnoteDefinition", "yaml"]);

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
  const first = firstBlock(parse(splitFences(markdown).prose).children);
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
