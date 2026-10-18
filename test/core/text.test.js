import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkText, markdownToPlain, normalizeInboundText, oneLine } from '../../src/core/text.js';

describe('chunkText', () => {
  it('returns one chunk for short text', () => {
    assert.deepEqual(chunkText('hello', 1800), ['hello']);
  });

  it('splits long text and keeps every chunk within the limit', () => {
    const text = Array.from({ length: 40 }, (_, index) => `第 ${index} 段内容，用来测试分片逻辑。`).join('\n\n');
    const chunks = chunkText(text, 120);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(Array.from(chunk).length <= 120, `chunk too long: ${Array.from(chunk).length}`);
      assert.ok(chunk.trim().length > 0);
    }
    // No content loss: joining normalized chunks reproduces the normalized input.
    assert.equal(chunks.join('\n').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
  });

  it('never splits an emoji surrogate pair', () => {
    const text = '😀'.repeat(500);
    const chunks = chunkText(text, 100);
    for (const chunk of chunks) {
      // A lone surrogate would make the string invalid; Array.from keeps pairs intact.
      assert.equal(Array.from(chunk).every((char) => char.length === 2), true);
    }
    assert.equal(chunks.join(''), text);
  });

  it('normalizes CRLF and trims', () => {
    assert.deepEqual(chunkText('a\r\nb\r\n', 100), ['a\nb']);
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(chunkText('   ', 100), []);
  });
});

describe('markdownToPlain', () => {
  it('drops common markdown scaffolding', () => {
    const input = '# 标题\n\n**粗体** 和 `代码`，见 [链接](https://example.com)\n\n- 一\n- 二\n\n```js\nconst a = 1;\n```';
    const output = markdownToPlain(input);
    assert.equal(output.includes('#'), false);
    assert.equal(output.includes('**'), false);
    assert.equal(output.includes('```'), false);
    assert.equal(output.includes('https://example.com'), true);
    assert.equal(output.includes('const a = 1;'), true);
  });
});

describe('normalizeInboundText', () => {
  it('decodes common entities and normalizes newlines', () => {
    assert.equal(normalizeInboundText('a&lt;b&gt;&amp;c\r\nd'), 'a<b>&c\nd');
    assert.equal(normalizeInboundText(undefined), '');
  });
});

describe('oneLine', () => {
  it('collapses whitespace and truncates', () => {
    assert.equal(oneLine('a\n\nb   c'), 'a b c');
    assert.equal(Array.from(oneLine('x'.repeat(50), 10)).length, 10);
  });
});
