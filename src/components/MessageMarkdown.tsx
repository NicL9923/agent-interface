import { Children, createContext, isValidElement, memo, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseReplyDocument, replyCardsFromText } from "../shared/reply-cards";
import { ReplyCards } from "./ReplyCards";
import "./message-markdown.css";

interface ReplyContextValue { actionableIds: Set<string>; botId?: string; messageId?: string; userId?: string; unavailable?: boolean }
const ReplyContext = createContext<ReplyContextValue | null>(null);
function MessagePre({ children }: { children?: ReactNode }) {
  const context = useContext(ReplyContext);
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) return <pre>{children}</pre>;
  const code = String(child.props.children ?? "");
  const language = child.props.className?.match(/(?:^|\s)language-(\S+)/)?.[1];
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

// Memoized because the composer re-renders the app on every keystroke, and
// re-parsing every reply in a long transcript made typing lag.
export const MessageMarkdown = memo(function MessageMarkdown({ text, botId, messageId, userId, unavailable }: {
  text: string; botId?: string; messageId?: string; userId?: string; unavailable?: boolean;
}) {
  const context = useMemo(() => ({ actionableIds: new Set(replyCardsFromText(text).map(card => card.id)), botId, messageId, userId, unavailable }), [text, botId, messageId, userId, unavailable]);
  return (
    <ReplyContext.Provider value={context}>
    <div className="message-markdown">
      <Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
    </ReplyContext.Provider>
  );
});
