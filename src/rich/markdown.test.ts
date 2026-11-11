import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, htmlToText, renderMarkdown } from './index.js';

const md = renderMarkdown;

describe('renderMarkdown', () => {
  it('renders bold, italic and strike', () => {
    expect(md('**bold** and _it_ and *it2* and ~~gone~~')).toBe(
      '<p><strong>bold</strong> and <em>it</em> and <em>it2</em> and <s>gone</s></p>',
    );
  });

  it('leaves underscores inside words and a lone asterisk alone', () => {
    expect(md('snake_case_name costs 2 * 3')).toBe('<p>snake_case_name costs 2 * 3</p>');
  });

  it('keeps line breaks in a paragraph and splits paragraphs on a blank line', () => {
    expect(md('a\nb\n\nc')).toBe('<p>a<br>b</p><p>c</p>');
    expect(md('a\r\nb')).toBe('<p>a<br>b</p>');
  });

  it("renders numbered and bulleted lists, keeping a numbered list's start", () => {
    expect(md('Steps:\n1. one\n2. two\n\n- a\n* b')).toBe(
      '<p>Steps:</p><ol><li>one</li><li>two</li></ol><ul><li>a</li><li>b</li></ul>',
    );
    expect(md('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  });

  it('nests an indented list under its item', () => {
    expect(md('1. top\n   - inner\n   - more\n2. next')).toBe('<ol><li>top<ul><li>inner</li><li>more</li></ul></li><li>next</li></ol>');
  });

  it('continues an item on an indented line, and switches list kind at a nested level', () => {
    expect(md('1. first\n   still first\n2. second')).toBe('<ol><li>first<br>still first</li><li>second</li></ol>');
    expect(md('1. top\n   - bullet\n   1. numbered')).toBe('<ol><li>top<ul><li>bullet</li></ul><ol><li>numbered</li></ol></li></ol>');
    expect(md('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  });

  it('renders a link with its text, escaping the address', () => {
    expect(md('see [the **doc**](https://example.com/a?b=1&c=2)')).toBe(
      '<p>see <a href="https://example.com/a?b=1&amp;c=2">the <strong>doc</strong></a></p>',
    );
  });

  it('leaves a link to anything but http(s) or mailto as literal text', () => {
    expect(md('[x](javascript:alert(1))')).toBe('<p>[x](javascript:alert(1))</p>');
  });

  it('renders inline code verbatim and escaped', () => {
    expect(md('run `a<b && **c**` now')).toBe('<p>run <code>a&lt;b &amp;&amp; **c**</code> now</p>');
  });

  it('renders a fenced code block verbatim', () => {
    expect(md('before\n```js\nif (a < b) {\n  go(); // **x**\n}\n```\nafter')).toBe(
      '<p>before</p><pre><code>if (a &lt; b) {\n  go(); // **x**\n}</code></pre><p>after</p>',
    );
  });

  it('escapes raw HTML and, by default, leaves headings, quotes and images as text', () => {
    expect(md('<b>x</b> <img src=x onerror=alert(1)>')).toBe('<p>&lt;b&gt;x&lt;/b&gt; &lt;img src=x onerror=alert(1)&gt;</p>');
    expect(md('# not a heading\n> not a quote\n![img](https://example.com/i.png)')).toBe(
      '<p># not a heading<br>&gt; not a quote<br>!<a href="https://example.com/i.png">img</a></p>',
    );
  });

  it('renders headings and nested quotes when asked', () => {
    expect(md('## Plan ##\ntext', { headings: true })).toBe('<h2>Plan</h2><p>text</p>');
    expect(md('#nospace', { headings: true })).toBe('<p>#nospace</p>');
    expect(md('> said\n> > earlier\n\nreply', { quotes: true })).toBe(
      '<blockquote><p>said</p><blockquote><p>earlier</p></blockquote></blockquote><p>reply</p>',
    );
  });

  it('honours backslash escapes', () => {
    expect(md('\\*not italic\\* and \\_nor this\\_')).toBe('<p>*not italic* and _nor this_</p>');
  });

  it('renders :shortcodes: through the hook, outside code only', () => {
    const shortcode = (k: string) => (k === 'rocket' ? '🚀' : k === 'smile' ? '<span class="e">🙂</span>' : undefined);
    expect(md(':smile: **hi** `:smile:` :nope: :rocket:_ship_', { shortcode })).toBe(
      '<p><span class="e">🙂</span> <strong>hi</strong> <code>:smile:</code> :nope: 🚀<em>ship</em></p>',
    );
    expect(md(':smile:')).toBe('<p>:smile:</p>');
  });

  it('cannot be tricked by its reserved placeholder characters, and passes others through', () => {
    expect(md('0 x')).toBe('<p>0 x</p>');
    expect(md('0 x')).toBe('<p>0 x</p>');
  });

  it('round-trips through htmlToMarkdown and reads back as text', () => {
    const src = '**Plan**\n\n1. one\n2. two\n\nsee [doc](https://example.com)';
    expect(htmlToMarkdown(md(src))).toBe(src);
    expect(htmlToText(md(src))).toBe('Plan\n1. one\n2. two\nsee doc (https://example.com)');
  });
});
