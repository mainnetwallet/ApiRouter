import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, parseBlocks } from "../markdown.jsx";

const html = (text, trailing) => renderToStaticMarkup(<Markdown text={text} trailing={trailing} />);

describe("markdown renderer", () => {
  it("renders headings, lists, bold, italic and inline code", () => {
    const out = html("# Title\n\n- one\n- **two**\n\nuse `npm test` and *care*");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<ul><li>one</li><li><strong>two</strong></li></ul>");
    expect(out).toContain("<code>npm test</code>");
    expect(out).toContain("<em>care</em>");
  });

  it("renders fenced code with a language label and a copy button", () => {
    const out = html("```js\nconst a = 1;\n```");
    expect(out).toContain("md-code__lang\">js<");
    expect(out).toContain("Copy code");
    expect(out).toContain("const a = 1;");
  });

  it("treats an unclosed fence as code while a reply is still streaming", () => {
    const [block] = parseBlocks("```py\nprint(1)");
    expect(block).toMatchObject({ type: "code", lang: "py", closed: false });
  });

  it("never turns model output into markup", () => {
    const out = html("<img src=x onerror=alert(1)> and [x](javascript:alert(1))");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("href=\"javascript:");
    expect(out).toContain("&lt;img");
  });

  it("only links http(s) and opens links safely", () => {
    const out = html("see https://example.com/docs.");
    expect(out).toContain('href="https://example.com/docs"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("renders tables and keeps the trailing cursor inside the last paragraph", () => {
    const table = html("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(table).toContain("<th>a</th>");
    expect(table).toContain("<td>2</td>");
    expect(html("hello", <i className="cur" />)).toContain("hello<i class=\"cur\"></i></p>");
  });
});
