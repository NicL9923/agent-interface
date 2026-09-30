import { Children, isValidElement, useState } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./message-markdown.css";

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
  pre({ children }) {
    const child = Children.toArray(children)[0];
    if (!isValidElement<{ children?: ReactNode; className?: string }>(child))
      return <pre>{children}</pre>;
    const code = String(child.props.children ?? "");
    const language = child.props.className?.match(/(?:^|\s)language-(\S+)/)?.[1];
    return <CodeBlock key={code} code={code} language={language} />;
  },
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

export function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="message-markdown">
      <Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
