/** Text helpers shared by the gateway: chunking and markdown degradation. */

/**
 * Split text into chunks no longer than `maxChars` code points, preferring
 * paragraph / sentence / word boundaries. Never splits a surrogate pair.
 *
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function chunkText(text, maxChars = 1800) {
  const limit = Math.max(100, Math.floor(maxChars));
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return [];
  if (Array.from(normalized).length <= limit) return [normalized];

  /** @type {string[]} */
  const chunks = [];
  let rest = normalized;
  while (Array.from(rest).length > limit) {
    const points = Array.from(rest);
    const window = points.slice(0, limit).join('');
    const cut = findCut(window, limit);
    const chunk = points.slice(0, cut).join('').trimEnd();
    if (chunk.length > 0) chunks.push(chunk);
    rest = points.slice(cut).join('').trimStart();
    if (chunks.length > 200) break; // defensive: never loop forever on pathological input
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Find the best split position inside `window` (in code points).
 * @param {string} window
 * @param {number} limit
 * @returns {number}
 */
function findCut(window, limit) {
  const points = Array.from(window);
  const min = Math.floor(limit * 0.5);
  /** @type {[string, number][]} */
  const separators = [
    ['\n\n', 4],
    ['\n', 3],
    ['。', 2],
    ['！', 2],
    ['？', 2],
    ['. ', 2],
    ['；', 1],
    [';', 1],
    ['，', 1],
    [',', 1],
    [' ', 1],
  ];
  let best = -1;
  for (const [separator, weight] of separators) {
    let index = window.lastIndexOf(separator);
    if (index < min) continue;
    // Prefer an earlier, higher-weight boundary over a later low-weight one.
    if (best === -1 || index + weight * 8 >= best) best = index + separator.length;
  }
  if (best > 0 && best <= limit) return best;
  return points.length;
}

/**
 * Conservative markdown -> plain text for channels without markdown support.
 * Keeps the prose, drops formatting scaffolding.
 *
 * @param {string} text
 * @returns {string}
 */
export function markdownToPlain(text) {
  return String(text ?? '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, body) => body)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * One-line summary with an ellipsis, for logs and status lines.
 * @param {string} text
 * @param {number} [maxChars]
 */
export function oneLine(text, maxChars = 120) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  const points = Array.from(compact);
  return points.length <= maxChars ? compact : `${points.slice(0, maxChars - 1).join('')}…`;
}

/**
 * Normalize an inbound text payload: unify newlines, trim, and decode the
 * most common HTML entities that IM platforms sometimes send.
 * @param {unknown} value
 */
export function normalizeInboundText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}
