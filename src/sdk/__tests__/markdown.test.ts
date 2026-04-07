// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import BundleLLM from "../sdk";

const render = BundleLLM.renderMarkdown;

describe("renderMarkdown", () => {
  describe("inline formatting", () => {
    it("renders inline code", () => {
      const html = render("Use `init()` to start");
      expect(html).toContain("<code");
      expect(html).toContain("init()");
    });

    it("renders bold text", () => {
      const html = render("This is **bold** text");
      expect(html).toContain("<strong>bold</strong>");
    });

    it("renders italic text", () => {
      const html = render("This is *italic* text");
      expect(html).toContain("<em>italic</em>");
    });

    it("renders bold before italic to handle nested markers", () => {
      const html = render("**bold** and *italic*");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<em>italic</em>");
    });
  });

  describe("links", () => {
    it("renders https links", () => {
      const html = render("Visit [BundleLLM](https://bundlellm.com)");
      expect(html).toContain('href="https://bundlellm.com"');
      expect(html).toContain("BundleLLM</a>");
    });

    it("renders http links", () => {
      const html = render("Visit [local](http://localhost:3000)");
      expect(html).toContain('href="http://localhost:3000"');
    });

    it("strips javascript: protocol links", () => {
      const html = render("[click](javascript:alert(1))");
      expect(html).not.toContain("href");
      expect(html).not.toContain("javascript:");
      expect(html).toContain("click");
    });

    it("strips javascript: with mixed case", () => {
      const html = render("[xss](JavaScript:alert(document.cookie))");
      expect(html).not.toContain("href");
      expect(html).not.toContain("JavaScript:");
    });

    it("strips data: protocol links", () => {
      const html = render("[xss](data:text/html,<script>alert(1)</script>)");
      expect(html).not.toContain("href");
      expect(html).not.toContain("data:");
    });

    it("strips vbscript: protocol links", () => {
      const html = render("[xss](vbscript:msgbox)");
      expect(html).not.toContain("href");
    });

    it("strips relative URL links", () => {
      const html = render("[Admin](/admin/delete-all)");
      expect(html).not.toContain("href");
      expect(html).toContain("Admin");
    });

    it("strips protocol-relative URLs", () => {
      const html = render("[xss](//evil.com/payload)");
      expect(html).not.toContain("href");
    });

    it("adds target=_blank and rel=noopener noreferrer to links", () => {
      const html = render("[safe](https://example.com)");
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
    });
  });

  describe("code blocks", () => {
    it("renders fenced code blocks", () => {
      const html = render("```\nconst x = 1;\n```");
      expect(html).toContain("<pre");
      expect(html).toContain("<code>");
      expect(html).toContain("const x = 1;");
    });

    it("renders code blocks with language label", () => {
      const html = render("```javascript\nconst x = 1;\n```");
      expect(html).toContain("javascript</span>");
      expect(html).toContain("const x = 1;");
    });

    it("escapes HTML inside code blocks", () => {
      const html = render("```\n<script>alert(1)</script>\n```");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
    });

    it("does not process markdown inside code blocks", () => {
      const html = render("```\n**not bold** and *not italic*\n```");
      expect(html).not.toContain("<strong>");
      expect(html).not.toContain("<em>");
    });

    it("does not process markdown inside inline code", () => {
      const html = render("Use `**kwargs` in Python");
      expect(html).not.toContain("<strong>");
      expect(html).toContain("**kwargs");
    });

    it("does not process links inside inline code", () => {
      const html = render("Use `[text](url)` for links");
      expect(html).not.toContain("<a ");
      expect(html).toContain("[text](url)");
    });
  });

  describe("headers", () => {
    it("renders h1", () => {
      const html = render("# Title");
      expect(html).toContain("font-size:1.2em");
      expect(html).toContain("Title");
    });

    it("renders h2", () => {
      const html = render("## Subtitle");
      expect(html).toContain("font-size:1.1em");
    });

    it("renders h3", () => {
      const html = render("### Section");
      expect(html).toContain("font-size:1em");
    });
  });

  describe("lists", () => {
    it("renders unordered lists with dashes", () => {
      const html = render("- Item 1\n- Item 2");
      expect(html).toContain("<ul");
      expect(html).toContain("<li");
      expect(html).toContain("Item 1");
      expect(html).toContain("Item 2");
    });

    it("renders unordered lists with asterisks", () => {
      const html = render("* Item 1\n* Item 2");
      expect(html).toContain("<ul");
    });

    it("renders ordered lists", () => {
      const html = render("1. First\n2. Second");
      expect(html).toContain("<ol");
      expect(html).toContain("First");
      expect(html).toContain("Second");
    });

    it("renders inline formatting within list items", () => {
      const html = render("- Use `init()` to start\n- It is **required**");
      expect(html).toContain("<code");
      expect(html).toContain("<strong>");
    });
  });

  describe("HTML escaping", () => {
    it("escapes HTML tags in regular text", () => {
      const html = render("<script>alert('xss')</script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
    });

    it("escapes HTML attributes so they are not executable", () => {
      const html = render('<img onerror="alert(1)" src=x>');
      expect(html).toContain("&lt;img");
      expect(html).toContain("&quot;");
      expect(html).not.toContain("<img");
    });

    it("escapes single quotes", () => {
      const html = render("it's a test");
      expect(html).toContain("&#39;");
    });
  });

  describe("streaming (partial markdown)", () => {
    it("handles incomplete code block during streaming", () => {
      const html = render("Here is code:\n```javascript\nconst x");
      // Should not throw, renders as-is
      expect(html).toContain("const x");
    });

    it("handles incomplete bold during streaming", () => {
      const html = render("This is **bold");
      // Incomplete bold renders as text with escaped asterisks
      expect(html).toContain("**bold");
    });
  });

  describe("mixed content", () => {
    it("renders text with code block and inline formatting", () => {
      const html = render("Use **BundleLLM** like this:\n\n```js\nBundleLLM.init()\n```\n\nThat's it!");
      expect(html).toContain("<strong>BundleLLM</strong>");
      expect(html).toContain("<pre");
      expect(html).toContain("BundleLLM.init()");
      expect(html).toContain("That&#39;s it!");
    });

    it("renders bold inside a link label", () => {
      const html = render("[**click**](https://example.com)");
      expect(html).toContain("<strong>click</strong>");
      expect(html).toContain("href=");
    });

    it("handles empty string input", () => {
      const html = render("");
      expect(html).toBeDefined();
      expect(typeof html).toBe("string");
    });

    it("handles multiple code blocks in one message", () => {
      const html = render("First:\n```js\nconst a = 1\n```\nSecond:\n```py\nx = 2\n```");
      expect(html).toContain("const a = 1");
      expect(html).toContain("x = 2");
      expect(html).toContain("js</span>");
      expect(html).toContain("py</span>");
    });
  });
});
