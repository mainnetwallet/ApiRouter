import { useRef, useState, useEffect } from "react";
import { Icon } from "../components/ui/Icon.jsx";
import { writeClipboard } from "../components/ui/CopyButton.jsx";

/**
 * Small, dependency-free markdown renderer for chat replies.
 *
 * It builds React elements only — never HTML strings — so model output can not
 * inject markup or scripts. Links are limited to http(s). It understands the
 * subset chat models actually produce: fenced code, headings, lists, quotes,
 * tables, rules, bold / italic / inline code and links. Anything else falls
 * through as plain text.
 *
 * Streaming-safe: an unclosed code fence is rendered as code to the end of the
 * text, so a reply does not flicker while it arrives.
 */

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const UL = /^(\s*)[-*+]\s+(.*)$/;
const OL = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function startsBlock(line, next) {
  return (
    FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) ||
    UL.test(line) || OL.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP.test(next))
  );
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

/** Parse text into a flat list of block descriptors. Exported for tests. */
export function parseBlocks(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (FENCE.test(lines[i]) && lines[i].trim() === "```") { closed = true; i += 1; break; }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "code", lang: fence[1] || "", text: body.join("\n"), closed });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (HR.test(line)) { blocks.push({ type: "hr" }); i += 1; continue; }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }

    const listMatch = UL.exec(line) ?? OL.exec(line);
    if (listMatch) {
      const ordered = OL.test(line) && !UL.test(line);
      const items = [];
      while (i < lines.length) {
        const current = lines[i];
        const m = (ordered ? OL : UL).exec(current);
        if (m) {
          items.push(m[2]);
          i += 1;
        } else if (current.trim() !== "" && /^\s{2,}\S/.test(current) && items.length > 0 && !UL.test(current) && !OL.test(current)) {
          items[items.length - 1] += `\n${current.trim()}`;
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({ type: ordered ? "ol" : "ul", items });
      continue;
    }

    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "p", text: para.join("\n") });
  }

  return blocks;
}

const INLINE_SOURCE = /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|(__[^\n]+?__)|(\*[^\s*][^*\n]*?\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function renderInline(text, keyPrefix = "i") {
  // A fresh regex per call: nested calls (bold containing code) would otherwise
  // share and reset one lastIndex and loop forever.
  const INLINE = new RegExp(INLINE_SOURCE.source, "g");
  const out = [];
  const source = String(text ?? "");
  let last = 0;
  let n = 0;

  const pushText = (value) => {
    if (!value) return;
    const parts = value.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) out.push(<br key={`${keyPrefix}-br-${n++}`} />);
      if (part) out.push(part);
    });
  };

  for (let match = INLINE.exec(source); match; match = INLINE.exec(source)) {
    pushText(source.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${n++}`;

    if (match[1]) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (match[2] || match[3]) {
      out.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (match[4]) {
      out.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else if (match[5]) {
      const split = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      out.push(
        <a key={key} href={split[2]} target="_blank" rel="noopener noreferrer">{split[1]}</a>
      );
    } else if (match[6]) {
      out.push(<a key={key} href={token} target="_blank" rel="noopener noreferrer">{token}</a>);
    }
    last = match.index + token.length;
  }

  pushText(source.slice(last));
  return out;
}

function CodeBlock({ lang, text }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await writeClipboard(text);
    if (!ok) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="md-code">
      <div className="md-code__head">
        <span className="md-code__lang">{lang || "code"}</span>
        <button type="button" className="md-code__copy" onClick={copy} aria-live="polite">
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? "Copied" : "Copy code"}
        </button>
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

const HEADING_TAGS = ["h1", "h2", "h3", "h4"];

/**
 * Render markdown. `trailing` (e.g. a streaming cursor) is placed at the end of
 * the last text block so it sits inline with the final word.
 */
export function Markdown({ text, trailing = null }) {
  const blocks = parseBlocks(text);
  const lastIndex = blocks.length - 1;

  return (
    <div className="md">
      {blocks.map((block, index) => {
        const tail = index === lastIndex ? trailing : null;
        const key = `b${index}`;

        switch (block.type) {
          case "code":
            return <CodeBlock key={key} lang={block.lang} text={block.text} />;
          case "heading": {
            const Tag = HEADING_TAGS[block.level - 1] ?? "h4";
            return <Tag key={key}>{renderInline(block.text, key)}{tail}</Tag>;
          }
          case "hr":
            return <hr key={key} />;
          case "quote":
            return <blockquote key={key}>{renderInline(block.text, key)}{tail}</blockquote>;
          case "ul":
          case "ol": {
            const List = block.type;
            return (
              <List key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>
                    {renderInline(item, `${key}-${itemIndex}`)}
                    {itemIndex === block.items.length - 1 ? tail : null}
                  </li>
                ))}
              </List>
            );
          }
          case "table":
            return (
              <div className="md-table" key={key}>
                <table>
                  <thead>
                    <tr>{block.head.map((cell, c) => <th key={c}>{renderInline(cell, `${key}h${c}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>{row.map((cell, c) => <td key={c}>{renderInline(cell, `${key}r${r}c${c}`)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <p key={key}>{renderInline(block.text, key)}{tail}</p>;
        }
      })}
      {blocks.length === 0 ? trailing : null}
      {blocks.length > 0 && blocks[lastIndex].type === "code" ? trailing : null}
    </div>
  );
}
