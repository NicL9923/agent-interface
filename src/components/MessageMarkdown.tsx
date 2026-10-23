import { Children, createContext, isValidElement, memo, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseReplyDocument, replyCardsFromText } from "../shared/reply-cards";
import { ReplyCards } from "./ReplyCards";
import { parseInlineDocument } from "../shared/inline-ui";
import { InlineUi } from "./InlineUi";
import "./message-markdown.css";

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
    : <CodeBlock key={code} code={code} language={language} />;
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");

  async function copy() {
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
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
        <code>{code}</code>
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

const components: Components = {
  a({ children, href, title }) {
    return href ? (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img({ src, alt, title }) {
    return typeof src === "string" && src ? (
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
    return (
      <div
        className="markdown-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Table"
      >
        <table {...tableProps}>{children}</table>
      </div>
    );
  },
};

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

const fence = /^ {0,3}(`{3,}|~{3,})/;
/**
 * Splits a reply that is still arriving into blocks that are finished and the one still growing,
 * so each update parses only the last. Splits fall on blank lines outside code fences that are
 * followed by a line at the margin, which always starts a new block. Returns null when a rule
 * spans the whole reply: reply cards and inline pages are judged together, reference links and
 * footnotes resolve anywhere, and HTML comments or raw blocks may contain blank lines.
 */
export function streamingBlocks(text: string): string[] | null {
  if (/^ {0,3}(`{3,}|~{3,})\s*(agent-ui|wildbots-html)\b/m.test(text) || /^ {0,3}\[[^\]]+\]:/m.test(text)
    || text.includes("[^") || text.includes("<!--") || /^ {0,3}<(pre|script|style|textarea)\b/im.test(text)) return null;
  const lines = text.split("\n"), blocks: string[] = [];
  let start = 0, open: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const marker = fence.exec(lines[index])?.[1];
    if (marker) {
      if (!open) open = marker;
      else if (marker[0] === open[0] && marker.length >= open.length && !lines[index].trim().slice(marker.length).trim()) open = undefined;
      continue;
    }
    const next = lines[index + 1];
    if (open || lines[index].trim() || index === start || !next?.trim() || /^\s/.test(next)) continue;
    blocks.push(lines.slice(start, index).join("\n"));
    start = index + 1;
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}

/**
 * A reply that is still arriving. Finished blocks keep their parsed output while the last one
 * grows, so a long reply no longer re-parses from the top several times a second. The saved
 * reply replaces this and is parsed whole.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown(props: MessageMarkdownProps) {
  const blocks = useMemo(() => streamingBlocks(props.text), [props.text]);
  if (!blocks) return <MessageMarkdown {...props} />;
  return <div className="message-markdown">{blocks.map((block, index) => <MarkdownBlocks key={index} {...props} text={block} />)}</div>;
});
