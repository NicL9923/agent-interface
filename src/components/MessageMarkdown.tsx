import { Children, createContext, isValidElement, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseReplyDocument, replyCardsFromText } from "../shared/reply-cards";
import { ReplyCards } from "./ReplyCards";
import { parseInlineDocument } from "../shared/inline-ui";
import { InlineUi } from "./InlineUi";
import { tableRows, tableToCsv, tableToMarkdown } from "./table-export";
import { streamingHoldBack } from "./streaming-hold-back";
import { graphemeCut, useRevealed } from "./streaming-reveal";
import "./message-markdown.css";

type Highlighter = typeof import("./code-highlight");
let highlighter: Highlighter | undefined;
let highlighterLoad: Promise<Highlighter> | undefined;
const loadHighlighter = () => highlighterLoad ??= import("./code-highlight").then(module => highlighter = module);

interface ReplyContextValue { text: string; inlineUi?: boolean; actionableIds: Set<string>; botId?: string; messageId?: string; userId?: string; unavailable?: boolean }
const ReplyContext = createContext<ReplyContextValue | null>(null);
function MessagePre({ children, node }: { children?: ReactNode; node?: { position?: { start: { offset?: number }; end: { offset?: number } } } }) {
  const context = useContext(ReplyContext);
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) return <pre>{children}</pre>;
  const code = String(child.props.children ?? "");
  const language = child.props.className?.match(/(?:^|\s)language-(\S+)/)?.[1];
  // A streaming fence can contain valid JSON before its closing fence arrives.
  const raw = context?.text.slice(node?.position?.start.offset, node?.position?.end.offset) || "";
  const fences = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*\n {0,3}(`{3,}|~{3,})[ \t]*$/.exec(raw);
  const closed = fences && fences[1][0] === fences[2][0] && fences[2].length >= fences[1].length;
  const inline = language === "wildbots-html" && context?.inlineUi && closed ? parseInlineDocument(code) : null;
  if (inline) return <InlineUi key={code} document={inline} />;
  const document = language === "agent-ui" && context?.botId && context.messageId ? parseReplyDocument(code) : null;
  return document && context && document.cards.every(card => context.actionableIds.has(card.id))
    ? <ReplyCards document={document} botId={context.botId} messageId={context.messageId} userId={context.userId} unavailable={context.unavailable} />
    // A finished block is keyed by its code; one still streaming keeps its node, and any selection in it.
    : <CodeBlock key={closed ? code : "open"} code={code} language={language} finished={!!closed} />;
}

/**
 * A fenced block. It renders plain at once and gains colors when the highlighter chunk is ready; color
 * alone never changes the layout. A fence still streaming in stays plain until its closing line arrives.
 */
function CodeBlock({ code, language, finished }: { code: string; language?: string; finished: boolean }) {
  // Feedback belongs to the code it copied; once a growing block changes, it no longer applies.
  const [copied, setCopied] = useState<{ state: "idle" | "copying" | "copied" | "failed"; code: string }>({ state: "idle", code });
  const copyState = copied.code === code ? copied.state : "idle";
  const highlightable = finished && !!language;
  const [html, setHtml] = useState(() => highlightable && highlighter ? highlighter.highlight(code, language!) : null);
  // A finished block is keyed by its code, so a result can only ever belong to this code.
  useEffect(() => {
    if (!highlightable || html !== null) return;
    loadHighlighter().then(module => setHtml(module.highlight(code, language!)), () => { /* Plain code still reads fine. */ });
  }, [highlightable, html, code, language]);

  async function copy() {
    const text = code;
    // A copy still pending when the code changes reports nothing, since it copied the older text.
    const settle = (state: "copied" | "failed") => setCopied(current => current.code === text ? { state, code: text } : current);
    setCopied({ state: "copying", code: text });
    try {
      await navigator.clipboard.writeText(text);
      settle("copied");
    } catch {
      settle("failed");
    }
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-language">{language || "Code"}</span>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={copyState === "copying"}
        >
          {copyState === "copying" ? "Copying…" : "Copy code"}
        </button>
      </div>
      <pre
        tabIndex={0}
        role="region"
        aria-label={language ? `${language} code block` : "Code block"}
      >
        {html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
      <span className="markdown-copy-status" role="status">
        {copyState === "copied"
          ? "Code copied."
          : copyState === "failed"
            ? "Couldn't copy. Select the code and copy it manually."
            : ""}
      </span>
    </div>
  );
}

/**
 * Whether a reply's link can open from this app. An assistant often links a file by its path on
 * the Hermes computer, such as /home/…/notes.md, which here would only open this app again.
 */
export function openableHref(href: string | undefined): href is string {
  if (!href) return false;
  // Web addresses, including protocol-relative ones, and in-page anchors.
  if (/^(?:https?:|mailto:|tel:|\/\/|#)/i.test(href)) return true;
  // This app's own destinations, such as /?view=today, and its signed files.
  return href === "/" || /^\/?[?#]/.test(href) || href.startsWith("/api/files/");
}
const localFile = "On the assistant's computer. Ask it to share the file to open it here.";

const components: Components = {
  a({ children, href, title }) {
    return openableHref(href) ? (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : href ? (
      <span className="markdown-local-file" title={localFile}>{children}</span>
    ) : (
      <span>{children}</span>
    );
  },
  img({ src, alt, title }) {
    return typeof src === "string" && openableHref(src) ? (
      <a href={src} title={title} target="_blank" rel="noopener noreferrer">
        {alt ? `Open image: ${alt}` : "Open image"}
      </a>
    ) : (
      <span>{alt || "Image unavailable"}</span>
    );
  },
  pre: MessagePre,
  table({ children, ...props }) {
    const { node: _node, ...tableProps } = props;
    return <MarkdownTable {...tableProps}>{children}</MarkdownTable>;
  },
};

/** A reply's table, with copies a spreadsheet or another chat can take. */
function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const table = useRef<HTMLTableElement>(null);
  const [status, setStatus] = useState("");
  async function copy(format: "Markdown" | "CSV") {
    const rows = table.current ? tableRows(table.current) : [];
    try {
      await navigator.clipboard.writeText(format === "CSV" ? tableToCsv(rows) : tableToMarkdown(rows));
      setStatus(`Table copied as ${format}.`);
    } catch {
      setStatus("Couldn't copy. Select the table and copy it manually.");
    }
  }
  return (
    <div className="markdown-table">
      <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="Table">
        <table ref={table} {...props}>{children}</table>
      </div>
      <div className="markdown-table-actions">
        <button type="button" onClick={() => void copy("Markdown")}>Copy as Markdown</button>
        <button type="button" onClick={() => void copy("CSV")}>Copy as CSV</button>
        <span className="markdown-copy-status" role="status">{status}</span>
      </div>
    </div>
  );
}

type MessageMarkdownProps = {
  text: string; botId?: string; messageId?: string; userId?: string; unavailable?: boolean; inlineUi?: boolean;
};

// Memoized because the composer re-renders the app on every keystroke, and
// re-parsing every reply in a long transcript made typing lag.
export const MessageMarkdown = memo(function MessageMarkdown(props: MessageMarkdownProps) {
  return <div className="message-markdown"><MarkdownBlocks {...props} /></div>;
});

/** One parsed piece of a reply, without its container, so several can share one. */
const MarkdownBlocks = memo(function MarkdownBlocks({ text, botId, messageId, userId, unavailable, inlineUi = false }: MessageMarkdownProps) {
  const context = useMemo(() => ({ text, inlineUi, actionableIds: new Set(replyCardsFromText(text).map(card => card.id)), botId, messageId, userId, unavailable }), [text, inlineUi, botId, messageId, userId, unavailable]);
  return (
    <ReplyContext.Provider value={context}>
      <Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </ReplyContext.Provider>
  );
});

// A backtick fence's info string cannot hold a backtick, so a line such as ```code``` is inline code.
const fence = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const listItem = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
// A list marker at any depth, and a fence indented past where the tracker below can see one.
const anyListItem = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const anyFence = /^[ \t]*(?:`{3,}|~{3,})/;
// A quote or list marker ahead of a line's content.
const containerMarker = String.raw`[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))`;
/**
 * Lines anywhere in a reply that the splitter cannot follow. Reply cards and inline pages are judged
 * together. A fence behind a quote or list marker is invisible to the fence tracker below, which
 * would then pair its indented closing line with the next fence and skip what lies between.
 */
const wholeReply = new RegExp(String.raw`^ {0,3}(?:\`{3,}|~{3,})\s*(?:agent-ui|wildbots-html)\b|^(?:${containerMarker})+[ \t]*(?:\`{3,}|~{3,})`, "m");
/**
 * Lines outside code fences that make one block depend on another. A reference-link or footnote
 * definition resolves uses anywhere in the reply; a use without one is literal text in both parses,
 * so only the definition matters. Its label may hold escaped brackets or run onto the next line,
 * so a line that opens a bracket and never closes it counts too. A line that opens an HTML block
 * may hold blank lines or fence-shaped lines that are not code. Each may sit in a quote or list
 * item; matching an indented code line or an autolink too only costs a full parse.
 */
const spansReply = new RegExp(String.raw`^(?:${containerMarker})*[ \t]*(?:\[(?:[^\\\]]|\\.)*(?:\]:|\\?$)|<[A-Za-z/?!])`);
const indent = (line: string) => {
  const space = /^[ \t]*/.exec(line)![0];
  return space.includes("\t") ? 4 : space.length;
};
/**
 * Splits a reply that is still arriving into blocks that are finished and the one still growing,
 * so each update parses only the last. Splits fall on blank lines outside code fences that are
 * followed by a line at the margin, which starts a new block, unless that line is a list item,
 * which may continue a loose list above it. Returns null when a rule spans the whole reply
 * (`wholeReply` anywhere, `spansReply` outside fences) or when a fence may close where the
 * tracker cannot see: a fence indented by up to three spaces may sit in a list item, which ends,
 * closing the fence, at a line indented less than the item's content. A fence indented four or
 * more after a list has started may open inside an item, where the tracker cannot follow it, so
 * that parses whole too. Inside a fence the other lines are code, so a code-heavy reply keeps
 * its blocks.
 */
export function streamingBlocks(text: string): string[] | null {
  if (wholeReply.test(text)) return null;
  const lines = text.split("\n"), blocks: string[] = [];
  let start = 0, open: string | undefined, openIndent = 0, listed = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (open && line.trim() && indent(line) < openIndent) return null;
    listed ||= anyListItem.test(line);
    if (!open && listed && indent(line) > 3 && anyFence.test(line)) return null;
    const marker = fence.exec(line)?.[1];
    if (marker) {
      if (!open) [open, openIndent] = [marker, indent(line)];
      else if (marker[0] === open[0] && marker.length >= open.length && !line.trim().slice(marker.length).trim()) open = undefined;
      continue;
    }
    if (!open && spansReply.test(line)) return null;
    const next = lines[index + 1];
    if (open || line.trim() || index === start || !next?.trim() || /^\s/.test(next) || listItem.test(next)) continue;
    blocks.push(lines.slice(start, index).join("\n"));
    start = index + 1;
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}

/**
 * A reply that is still arriving. Finished blocks keep their parsed output while the last one
 * grows, so a long reply no longer re-parses from the top several times a second. A short
 * unfinished marker, link or table header at the growing end is held back until it is whole, so it
 * does not flash as raw Markdown. The saved reply replaces this and is parsed whole.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown(props: MessageMarkdownProps) {
  const blocks = useMemo(() => {
    const split = streamingBlocks(props.text);
    return split ? [...split.slice(0, -1), streamingHoldBack(split.at(-1)!)] : null;
  }, [props.text]);
  const whole = useMemo(() => blocks ? "" : streamingHoldBack(props.text), [blocks, props.text]);
  if (!blocks) return <MessageMarkdown {...props} text={whole} />;
  return <div className="message-markdown">{blocks.map((block, index) => <MarkdownBlocks key={index} {...props} text={block} />)}</div>;
});

/**
 * A reply still arriving, as the transcript's live row shows it. Its text is revealed at a steady
 * pace (see streaming-reveal.ts), then split and held back as StreamingMarkdown does. Revealing
 * comes first so the hold-back judges the end a person actually sees: a cut the reveal makes
 * inside `**bold**` is held back like one the stream made. Both keep a prefix, so the result is a
 * prefix of what arrived. A caret follows the last character until the row is saved.
 */
export const LiveMarkdown = memo(function LiveMarkdown(props: MessageMarkdownProps) {
  const text = useRevealed(props.text);
  return <>
    <StreamingMarkdown {...props} text={text} />
    <StreamingCaret text={text} />
  </>;
});

// Text a person reads in the reply, not a control's label or a status line.
const notReplyText = "button, [role=status], [aria-hidden=true], .markdown-code-header";

type Box = { left: number; right: number; top: number; bottom: number };
/** Digits run left to right even inside right-to-left text. */
const digit = /^\p{Nd}/u;
/** Letters of the scripts written right to left. */
const rightToLeft = /^[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
const letter = /^\p{L}/u;
/**
 * Which edge of the reply's last grapheme is the text's logical end: its trailing edge in the
 * direction it runs. A letter's direction is its script's, wherever it sits, and a digit runs left
 * to right. Punctuation, spaces and symbols take their direction from the text around them, so
 * the browser's own layout decides: if the grapheme before it on the same line lies to its right,
 * the text runs right to left there. With nothing before it on the line, the paragraph's direction
 * decides, as it does for the browser.
 */
export function logicalEndSide(grapheme: string, last: Box, previous: Box | undefined, direction: string): "left" | "right" {
  if (digit.test(grapheme)) return "right";
  if (rightToLeft.test(grapheme)) return "left";
  if (letter.test(grapheme)) return "right";
  if (previous && previous.top < last.bottom && previous.bottom > last.top)
    return previous.left + previous.right > last.left + last.right ? "left" : "right";
  return direction === "rtl" ? "left" : "right";
}

const measure = (node: Text, start: number, end: number) => {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const rects = range.getClientRects?.();
  return rects?.length ? rects[rects.length - 1] : undefined;
};
/**
 * Where the reply's last visible character ends, skipping trailing space and the labels of copy
 * controls: the x of its logical end, its line's top and height, and the text node it is in. It
 * measures the last grapheme and the one before it, not a collapsed range, since browsers differ
 * on a collapsed range's rectangle and on which side of a bidirectional boundary it lies.
 */
function textEnd(box: Element): { x: number; side: "left" | "right"; top: number; height: number; node: Text } | undefined {
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, {
    acceptNode: node => /\S/.test(node.nodeValue ?? "") && !node.parentElement?.closest(notReplyText) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const node = walker.lastChild() as Text | null;
  if (!node) return undefined;
  const end = node.data.search(/\S\s*$/) + 1;
  const start = graphemeCut(node.data, end - 1);
  const last = measure(node, start, end);
  if (!last) return undefined;
  const previous = start > 0 ? measure(node, graphemeCut(node.data, start - 1), start) : undefined;
  const direction = node.parentElement ? getComputedStyle(node.parentElement).direction : "ltr";
  const side = logicalEndSide(node.data.slice(start, end), last, previous, direction);
  return { x: side === "left" ? last.left : last.right, side, top: last.top, height: last.height, node };
}
/** The part of the reply where the text shows: inside the code block or table that scrolls it sideways, if any. */
function visibleArea(from: Node, box: Element): Box {
  const area = box.getBoundingClientRect();
  for (let element = from.parentElement; element && element !== box; element = element.parentElement) {
    if (!/auto|scroll|hidden/.test(getComputedStyle(element).overflowX)) continue;
    const clip = element.getBoundingClientRect();
    return { left: Math.max(area.left, clip.left), right: Math.min(area.right, clip.right), top: clip.top, bottom: clip.bottom };
  }
  return area;
}
/** The space between the last character and the caret. */
const CARET_GAP = 2;
/**
 * Puts the caret at the logical end of the reply's text: after its last character in the direction
 * that text runs, so right of Latin text and left of Arabic or Hebrew. It is absolutely positioned
 * against its containing block, so it never moves the text, and it has no text of its own to
 * select or read. It stays inside the visible part of a code block or table that scrolls sideways.
 */
function placeCaret(caret: HTMLElement) {
  const box = caret.previousElementSibling, parent = caret.offsetParent;
  if (!box || !(parent instanceof HTMLElement)) return;
  const base = parent.getBoundingClientRect(), end = textEnd(box);
  const area = visibleArea(end?.node ?? box, box), width = caret.offsetWidth;
  const side = end?.side ?? "right", at = !end ? area.left : side === "left" ? end.x - CARET_GAP - width : end.x + CARET_GAP;
  // Text flush with an edge, such as Arabic in a left-to-right paragraph, puts the caret just outside it.
  const least = area.left - (side === "left" ? CARET_GAP + width : 0), most = area.right + (side === "right" ? CARET_GAP : -width);
  const x = Math.max(least, Math.min(at, most)) - base.left - parent.clientLeft + parent.scrollLeft;
  const y = (end ? end.top : area.top) - base.top - parent.clientTop + parent.scrollTop;
  caret.style.transform = `translate(${x}px, ${y}px)`;
  caret.style.height = end ? `${end.height}px` : "";
}
function StreamingCaret({ text }: { text: string }) {
  const caret = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { if (caret.current) placeCaret(caret.current); }, [text]);
  useEffect(() => {
    const element = caret.current, box = element?.previousElementSibling;
    if (!element || !box) return;
    // Scrolling a code block or table sideways moves the text under the caret. Scroll events do not
    // bubble, so the reply hears its own blocks' in the capture phase, and places the caret once a frame.
    let frame = 0;
    const scrolled = () => { frame ||= requestAnimationFrame(() => { frame = 0; placeCaret(element); }); };
    box.addEventListener("scroll", scrolled, { capture: true, passive: true });
    // A narrower window or a late image moves the text without changing it.
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => placeCaret(element));
    observer?.observe(box);
    return () => {
      box.removeEventListener("scroll", scrolled, { capture: true });
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, []);
  return <span ref={caret} className="streaming-caret" aria-hidden="true" />;
}
