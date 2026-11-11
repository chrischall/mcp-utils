import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  attr,
  bodyStructure,
  decodeEntities,
  escapeHtml,
  htmlToMarkdown,
  htmlToText,
  isRichHtml,
  linksOf,
  parseHtml,
  renderMarkdown,
  sanitiseHtml,
  type HtmlReadOptions,
} from './index.js';

/* A Teams-style hook: keep @mention spans, show emoji images as their character, other images as [image]. */
const MENTION_TYPE = 'http://schema.skype.com/Mention';
const teams: HtmlReadOptions = {
  element: (el, output, inner) => {
    if (el.tag === 'img') {
      const alt = attr(el.attrs, 'alt');
      const text = /schema\.skype\.com\/Emoji/i.test(attr(el.attrs, 'itemtype') ?? '') && alt ? decodeEntities(alt) : '[image]';
      return output === 'html' ? escapeHtml(text) : text;
    }
    if (el.tag === 'span' && attr(el.attrs, 'itemtype') === MENTION_TYPE) {
      if (output === 'markdown') return `@${inner.trim()}`;
      if (output === 'html') {
        const id = attr(el.attrs, 'itemid');
        return `<span itemtype="${MENTION_TYPE}"${id !== undefined && /^\d+$/.test(id) ? ` itemid="${id}"` : ''}>${inner}</span>`;
      }
    }
    return undefined;
  },
};
const MENTION = (n: number, name: string) => `<span itemscope="" itemtype="${MENTION_TYPE}" itemid="${n}">${name}</span>`;

describe('decodeEntities / escapeHtml', () => {
  it('decodes named and numeric references once', () => {
    expect(decodeEntities('a &amp;lt; b &#65;&#x42; &nbsp;&unknown;')).toBe('a &lt; b AB  &unknown;');
  });
  it('drops control characters but keeps tab and newline', () => {
    expect(decodeEntities('a&#1;b&#9;c&#10;d')).toBe('ab\tc\nd');
  });
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('sanitiseHtml', () => {
  it('keeps formatting tags and drops their attributes', () => {
    expect(sanitiseHtml('<p style="color:red" class="x"><b data-x="1">bold</b> <em>it</em></p>')).toBe(
      '<p><b>bold</b> <em>it</em></p>',
    );
  });

  it('keeps lists, code, quotes, headings and tables', () => {
    const html =
      '<ol start="3"><li>a</li><li>b</li></ol><ul><li>c</li></ul><pre class="language-js"><code>x &lt; 1</code></pre>' +
      '<blockquote><p>q</p></blockquote><h2>H</h2><table><tr><td>1</td></tr></table>';
    expect(sanitiseHtml(html)).toBe(
      '<ol start="3"><li>a</li><li>b</li></ol><ul><li>c</li></ul><pre><code>x &lt; 1</code></pre>' +
        '<blockquote><p>q</p></blockquote><h2>H</h2><table><tr><td>1</td></tr></table>',
    );
  });

  it('removes script, style, head and xml elements with their content, and unknown tags but not their text', () => {
    expect(
      sanitiseHtml('<head><title>t</title></head><p>a<script>alert(1)</script><style>p{}</style><xml><o:x/></xml><font face="x">b</font></p>'),
    ).toBe('<p>ab</p>');
  });

  it('drops comments, Outlook conditional comments and doctype', () => {
    expect(sanitiseHtml('<!DOCTYPE html><p>a<!--[if mso]>mso only<![endif]-->b<![if !mso]>c<![endif]></p>')).toBe('<p>abc</p>');
  });

  it('keeps only http(s) and mailto link targets', () => {
    expect(sanitiseHtml('<a href="https://example.com/?a=1&amp;b=2" onclick="x()">ok</a>')).toBe(
      '<a href="https://example.com/?a=1&amp;b=2">ok</a>',
    );
    expect(sanitiseHtml('<a href="javascript:alert(1)">bad</a>')).toBe('bad');
    expect(sanitiseHtml('<a href="mailto:a@example.com">mail</a>')).toBe('<a href="mailto:a@example.com">mail</a>');
  });

  it('shows an image as its alt text, and drops one with none', () => {
    expect(sanitiseHtml('<p><img alt="Logo &amp; co" src="x"><img src="pixel.gif" alt=""></p>')).toBe('<p>[Logo &amp; co]</p>');
  });

  it('lets a hook keep its own elements (Teams mention spans and emoji)', () => {
    expect(sanitiseHtml(`<p>hi ${MENTION(0, 'Alex Example')} <span style="x">there</span></p>`, teams)).toBe(
      `<p>hi <span itemtype="${MENTION_TYPE}" itemid="0">Alex Example</span> there</p>`,
    );
    const emoji = '<img itemtype="http://schema.skype.com/Emoji" alt="🙂" src="https://statics.example/e.png">';
    expect(sanitiseHtml(`<p>${emoji}<img src="https://example.test/views/imgo"></p>`, teams)).toBe('<p>🙂[image]</p>');
  });

  it('writes CRLF line endings as LF, and escapes stray angle brackets', () => {
    expect(sanitiseHtml('<p>a</p>\r\n<p>b 1 < 2</p>')).toBe('<p>a</p>\n<p>b 1 &lt; 2</p>');
  });

  it('closes tags left open and ignores stray closing tags', () => {
    expect(sanitiseHtml('<p><b>x</p></i>y')).toBe('<p><b>x</b></p>y');
  });
});

describe('hidden content', () => {
  it('is dropped with everything inside it by default', () => {
    const html =
      '<div style="display:none!important; font-size:1px">preheader <b>text</b></div>' +
      '<p hidden>secret</p><span style="visibility: hidden">x</span><p style="mso-hide:all">mso</p><p>shown</p>';
    expect(htmlToText(html)).toBe('shown');
    expect(sanitiseHtml(html)).toBe('<p>shown</p>');
    expect(linksOf('<div style="display:none"><a href="https://hidden.example">h</a></div>')).toEqual([]);
  });

  it('is kept with keepHidden', () => {
    expect(htmlToText('<div style="display:none">preheader</div><p>shown</p>', { keepHidden: true })).toBe('preheader\nshown');
  });

  it('does not mistake a visible element for a hidden one', () => {
    expect(htmlToText('<p style="display:block" data-hidden-x="1" class="hidden">a</p><p title="hidden">b</p>')).toBe('a\nb');
    expect(htmlToText('<div title="Reveal hidden fees">Fees</div><p aria-label=\'Show hidden items\' data-x=hidden>Items</p>')).toBe(
      'Fees\nItems',
    );
    expect(htmlToText('<p style="content: \'display:none\'">c</p>')).toBe('c');
  });
});

describe('isRichHtml', () => {
  it('is false for plain paragraphs and line breaks', () => {
    expect(isRichHtml('<p>one<br>two</p><div>three</div>')).toBe(false);
  });
  it('is true for formatting, lists and links (and hooked elements)', () => {
    expect(isRichHtml('<p><b>x</b></p>')).toBe(true);
    expect(isRichHtml('<ol><li>a</li></ol>')).toBe(true);
    expect(isRichHtml('<a href="https://x.example">x</a>')).toBe(true);
    expect(isRichHtml(`<p>${MENTION(0, 'A')}</p>`, teams)).toBe(true);
    expect(isRichHtml(`<p>${MENTION(0, 'A')}</p>`)).toBe(false);
  });
});

describe('linksOf / bodyStructure', () => {
  it('lists each link with its text, in order, once', () => {
    const html =
      '<p><a href="https://a.example/x?y=1&amp;z=2">the <b>doc</b></a> and <a href="https://b.example">https://b.example</a>' +
      ' and <a href="https://a.example/x?y=1&amp;z=2">the doc</a> <a href="javascript:x">no</a></p>';
    expect(linksOf(html)).toEqual([
      { href: 'https://a.example/x?y=1&z=2', text: 'the doc' },
      { href: 'https://b.example', text: 'https://b.example' },
    ]);
  });

  it('reads a link label like htmlToText, one line: blocks and line breaks become spaces', () => {
    expect(linksOf('<a href="https://a.example"><p>Read</p><p>the <code>x\u200by</code><br>doc\u200b</p></a>')).toEqual([
      { href: 'https://a.example', text: 'Read the x\u200by doc' },
    ]);
  });

  it('gives sanitised HTML only for a formatted body, and its links', () => {
    expect(bodyStructure('<p>plain</p>')).toEqual({ links: [] });
    expect(bodyStructure('<p><a href="https://a.example">a</a></p>')).toEqual({
      contentHtml: '<p><a href="https://a.example">a</a></p>',
      links: [{ href: 'https://a.example', text: 'a' }],
    });
  });
});

describe('htmlToText', () => {
  it('keeps list numbering, links as text (url), table rows and quote depth', () => {
    const html =
      '<p>Plan</p><ol start="2"><li>one</li><li>two</li></ol><ul><li>x</li></ul>' +
      '<p>see <a href="https://a.example/d">doc</a> or <a href="https://b.example/long">https://b.example/lo…</a></p>' +
      '<table><tr><td>a</td><td></td><td>b</td><td></td></tr></table><blockquote><p>q1</p><blockquote>q2</blockquote></blockquote>';
    expect(htmlToText(html)).toBe(
      'Plan\n2. one\n3. two\n- x\nsee doc (https://a.example/d) or https://b.example/long\na | | b\n> q1\n> > q2',
    );
  });
});

describe('htmlToText links', () => {
  it('shows only http(s) and mailto targets, like Markdown and linksOf', () => {
    expect(htmlToText('<p><a href="javascript:alert(1)">click</a> <a href="data:text/html,x">d</a> <a href="mailto:a@x.example">mail</a></p>')).toBe(
      'click d mail (mailto:a@x.example)',
    );
  });
});

describe('htmlToMarkdown', () => {
  it('renders bold, italic, strike and inline code', () => {
    expect(htmlToMarkdown('<p><b>bold</b> <i>it</i> <s>gone</s> <code>x()</code></p>')).toBe('**bold** _it_ ~~gone~~ `x()`');
  });

  it('numbers an ordered list from its start, and bullets an unordered one', () => {
    expect(htmlToMarkdown('<p>Steps:</p><ol><li>one</li><li>two</li></ol><ul><li>a</li><li>b</li></ul>')).toBe(
      'Steps:\n\n1. one\n2. two\n\n- a\n- b',
    );
    expect(htmlToMarkdown('<ol start="4"><li>four</li><li>five</li></ol>')).toBe('4. four\n5. five');
  });

  it('indents a nested list under its item', () => {
    expect(htmlToMarkdown('<ol><li>top<ul><li>inner</li></ul></li><li>next</li></ol>')).toBe('1. top\n   - inner\n2. next');
  });

  it('renders links with their text, and a bare link as its address', () => {
    expect(htmlToMarkdown('<p><a href="https://a.example/doc">the doc</a></p>')).toBe('[the doc](https://a.example/doc)');
    expect(htmlToMarkdown('<p><a href="https://a.example/very/long/path">https://a.example/very/lo…</a></p>')).toBe(
      'https://a.example/very/long/path',
    );
  });

  it('renders a code block fenced, its text kept verbatim', () => {
    expect(htmlToMarkdown('<pre><code>if (a &lt; b) {\n  go();\n}</code></pre>')).toBe('```\nif (a < b) {\n  go();\n}\n```');
  });

  it('renders headings, quotes, rules and data tables', () => {
    expect(htmlToMarkdown('<h2>Title</h2><p>x</p><hr><p>y</p>')).toBe('## Title\n\nx\n\n---\n\ny');
    expect(htmlToMarkdown('<blockquote><p><b>Sam</b></p><p>said this</p></blockquote><p>reply</p>')).toBe(
      '> **Sam**\n>\n> said this\n\nreply',
    );
    expect(htmlToMarkdown('<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>')).toBe(
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
    );
  });

  it('reads a one-column layout table as its blocks, keeping their structure', () => {
    expect(htmlToMarkdown('<table><tr><td><p>Hello</p></td></tr><tr><td></td></tr><tr><td><b>Bye</b></td></tr></table>')).toBe(
      'Hello\n\n**Bye**',
    );
    expect(htmlToMarkdown('<table><tbody><tr><td><p>Hi</p><ol><li>one</li><li>two</li></ol></td></tr></tbody></table>')).toBe(
      'Hi\n\n1. one\n2. two',
    );
  });

  it('reads a one-row table in line, and an image alone in a link as its alt text', () => {
    expect(
      htmlToMarkdown(
        '<table><tr><td><a href="https://a.example/r">Reply</a></td><td></td>' +
          '<td><a href="https://a.example/up"><img alt="Thumbs Up" src="x.png"></a></td></tr></table>',
      ),
    ).toBe('[Reply](https://a.example/r) [Thumbs Up](https://a.example/up)');
  });

  it('renders a nested table once, inside its cell', () => {
    const html =
      '<table><tr><td><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></td></tr><tr><td>after</td></tr></table>';
    expect(htmlToMarkdown(html)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter');
    expect(htmlToText(html)).toBe('a | b\n1 | 2\nafter');
  });

  it('lets a hook render its own elements', () => {
    expect(htmlToMarkdown(`<p>hi ${MENTION(0, 'Alex Example')}</p>`, teams)).toBe('hi @Alex Example');
    expect(
      htmlToMarkdown(
        '<p><span style="x">see</span> <img src="https://example.test/views/imgo"> ' +
          '<img itemtype="http://schema.skype.com/Emoji" alt="🙂"></p>',
        teams,
      ),
    ).toBe('see [image] 🙂');
  });

  it('keeps line breaks inside a paragraph and decodes entities', () => {
    expect(htmlToMarkdown('<p>a &amp; b<br>c&nbsp;d</p>')).toBe('a & b\nc d');
  });
});

describe('hostile input', () => {
  const time = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };

  it('parses unclosed tags, quotes and comments in linear time', () => {
    const n = 200_000;
    for (const evil of ['<a'.repeat(n / 2), `<a "${'x'.repeat(n)}`, "<a '<a '".repeat(n / 8), '<!--'.repeat(n / 4), '&#'.repeat(n / 2)]) {
      expect(time(() => htmlToMarkdown(evil))).toBeLessThan(500);
    }
  });

  it('flattens nesting past MAX_DEPTH instead of overflowing the stack', () => {
    const deep = '<div><b>'.repeat(20_000) + 'core' + '</b></div>'.repeat(20_000);
    expect(htmlToText(deep)).toBe('core');
    expect(htmlToMarkdown(deep)).toContain('core');
    let depth = 0;
    for (let el = parseHtml(deep); typeof el.children[0] === 'object'; el = el.children[0]) depth++;
    expect(depth).toBeLessThanOrEqual(MAX_DEPTH + 1);
  });

  it('renders hooked nested lists and tables in linear time (each subtree once)', () => {
    let calls = 0;
    const counting: HtmlReadOptions = { element: () => (calls++, undefined) };
    const lists = '<ul><li>'.repeat(60) + 'x' + '</li></ul>'.repeat(60);
    const tables = '<table><tr><td>'.repeat(60) + 'x' + '</td></tr></table>'.repeat(60);
    for (const html of [lists, tables]) {
      for (const output of ['markdown', 'text'] as const) {
        calls = 0;
        const run = output === 'markdown' ? htmlToMarkdown : htmlToText;
        expect(time(() => run(html, counting))).toBeLessThan(200);
        expect(run(html, counting)).toContain('x');
        // One hook call per element per render, never one per path through the tree.
        expect(calls).toBeLessThan(400);
      }
    }
  });

  it('renders a hooked, deeply nested body in linear time', () => {
    const nested = '<span>'.repeat(150) + 'x' + '</span>'.repeat(150);
    expect(time(() => htmlToMarkdown(nested, { element: () => undefined }))).toBeLessThan(200);
  });
});

/* Gaps found adopting /rich in workday-mcp (Workday rich text, captured live). */
describe('workday gaps', () => {
  it('a. a list item that starts with a block keeps its marker on the same line', () => {
    expect(htmlToText('<ul><li><p>one</p></li><li><p>two</p></li></ul>')).toBe('- one\n- two');
    expect(htmlToText('<ol><li><p>one</p><p>more</p></li></ol>')).toBe('1. one\nmore');
  });

  it('b. paragraphs: keeps one blank line between blocks and <br><br>, collapsing runs', () => {
    const p = { paragraphs: true };
    expect(htmlToText('<p>x</p><p></p><p>y</p>', p)).toBe('x\n\ny');
    expect(htmlToText('a<br /><br />b', p)).toBe('a\n\nb');
    expect(htmlToText('a<br />\n<br /><br /><br />b', p)).toBe('a\n\nb');
    expect(htmlToText('a<br />b', p)).toBe('a\nb');
    expect(htmlToText('<p>a</p><br /><p>b</p>', p)).toBe('a\n\nb');
    expect(htmlToText('<p style="text-align:left">Intro</p>\n<ul>\n  <li><p>one</p></li>\n  <li>two</li>\n</ul><p>End</p>', p)).toBe(
      'Intro\n\n- one\n- two\n\nEnd',
    );
    expect(htmlToText('<p>a</p><blockquote><p>q1</p><p>q2</p></blockquote><p>b</p>', p)).toBe('a\n\n> q1\n>\n> q2\n\nb');
    expect(htmlToText('<p>a</p><table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>', p)).toBe('a\n\n1 | 2\n3 | 4');
  });

  it('b. without paragraphs, blank lines are still dropped', () => {
    expect(htmlToText('<p>x</p><p></p><p>y</p>')).toBe('x\ny');
    expect(htmlToText('a<br /><br />b')).toBe('a\nb');
  });

  it('c. decodes legacy named references written without a semicolon, but not inside a longer word', () => {
    expect(htmlToText('Blank&nbsp label')).toBe('Blank label');
    expect(decodeEntities('a &amp b &lt c &gt d &quot e')).toBe('a & b < c > d " e');
    expect(decodeEntities('&ampersand &ltx &amp=1 &nbspx')).toBe('&ampersand &ltx &amp=1 &nbspx');
    expect(decodeEntities('&amp;lt; &#39;&#34;&#x2019;')).toBe('&lt; \'"’');
  });

  it('d. sanitiseHtml limits output to a tag subset, keeping text; the hook runs first', () => {
    const subset = {
      tags: ['p', 'br', 'b', 'ul', 'li'],
      element: (el: { tag: string }, output: string, inner: string) =>
        output === 'html' && el.tag === 'strong' ? `<b>${inner}</b>` : undefined,
    };
    const md = renderMarkdown('**x** and [link](https://a.example/l) and `code`\n\n- one\n- two\n\n## Head', { headings: true });
    expect(sanitiseHtml(md, subset)).toBe('<p><b>x</b> and link and code</p><ul><li>one</li><li>two</li></ul>Head');
    expect(sanitiseHtml('<p><i>i</i><br>x</p>', { tags: new Set(['p']) })).toBe('<p>ix</p>');
  });

  it('e. strips invisible format characters from text and Markdown, but not inside code, and keeps emoji joiners', () => {
    expect(htmlToText('<p>Q?</p>​')).toBe('Q?');
    expect(htmlToText('a‌b⁠c﻿d&#x200b;e')).toBe('abcde');
    expect(htmlToMarkdown('<p>Q?​</p><pre><code>x​y</code></pre> <code>z​</code>')).toBe('Q?\n\n```\nx​y\n```\n\n`z​`');
    expect(htmlToText('<p>👩‍💻 dev</p>')).toBe('👩‍💻 dev');
  });
});
