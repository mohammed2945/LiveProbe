"use client";

import { Fragment, type ReactNode, useState } from "react";

const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;
const ENV_NAME = /^([A-Za-z_][A-Za-z0-9_]*)=/;

// Deliberately not a real tokenizer. The design only asks for two things to
// stand out — the identifier on the left of a JSON or dotenv assignment, and
// JSON string values — and both formats are regular enough to pick out with a
// pattern. Anything richer would mean shipping a highlighter to a static site
// that has no other client-side dependencies.
function highlightJson(code: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;

  for (const match of code.matchAll(JSON_STRING)) {
    const start = match.index;
    const literal = match[0];
    if (start > cursor) parts.push(code.slice(cursor, start));
    const isKey = /^\s*:/.test(code.slice(start + literal.length));
    parts.push(
      <span key={start} className={isKey ? "token-key" : "token-string"}>
        {literal}
      </span>,
    );
    cursor = start + literal.length;
  }

  if (cursor < code.length) parts.push(code.slice(cursor));
  return parts;
}

function highlightDotenv(code: string): ReactNode[] {
  const lines = code.split("\n");
  return lines.map((line, index) => {
    const name = ENV_NAME.exec(line);
    return (
      <Fragment key={index}>
        {name ? (
          <>
            <span className="token-key">{name[1]}</span>
            {line.slice(name[1].length)}
          </>
        ) : (
          line
        )}
        {index < lines.length - 1 ? "\n" : null}
      </Fragment>
    );
  });
}

function highlight(code: string, language: string): ReactNode {
  if (language === "json") return highlightJson(code);
  if (language === "dotenv") return highlightDotenv(code);
  return code;
}

export function CodeBlock({
  code,
  language = "text",
}: {
  code: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        <button
          type="button"
          className="copy-button"
          onClick={copyCode}
          aria-label="Copy code"
          title="Copy code"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre>
        <code>{highlight(code, language)}</code>
      </pre>
    </div>
  );
}
