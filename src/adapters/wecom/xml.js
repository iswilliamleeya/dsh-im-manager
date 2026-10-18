/**
 * WeCom callback payload parsing.
 *
 * 自建应用 callbacks are XML (`<xml><ToUserName>…</ToUserName>…</xml>`), while
 * a few message shapes are JSON. The parser is intentionally tolerant: values
 * are kept as strings (MsgId must not lose precision) and CDATA is unwrapped.
 */
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  trimValues: true,
  alwaysCreateTextNode: false,
});

/**
 * Parse a WeCom XML document. Returns the `<xml>` element contents as a plain
 * object, or null when the input is not parseable XML.
 * @param {string} xml
 * @returns {Record<string, any> | null}
 */
export function parseWecomXml(xml) {
  const trimmed = String(xml ?? '').trim();
  if (!trimmed.startsWith('<')) return null;
  try {
    const parsed = parser.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    const root = parsed.xml ?? parsed;
    return root && typeof root === 'object' ? root : null;
  } catch {
    return null;
  }
}

/**
 * Parse a decrypted callback body: XML when it starts with `<`, JSON otherwise.
 * @param {string | Buffer} payload
 * @returns {Record<string, any> | null}
 */
export function parseWecomPayload(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('<')) return parseWecomXml(trimmed);
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Normalize a parsed XML/JSON node to a string ("" for missing values).
 * Handles CDATA objects, arrays (first element) and numeric nodes.
 * @param {unknown} value
 * @returns {string}
 */
export function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return asText(value[0]);
  if (typeof value === 'object') {
    const record = /** @type {Record<string, any>} */ (value);
    if (typeof record['#text'] === 'string') return record['#text'];
    return '';
  }
  return '';
}

/**
 * First non-empty string among the given values.
 * @param {...unknown} values
 * @returns {string}
 */
export function firstText(...values) {
  for (const value of values) {
    const text = asText(value);
    if (text !== '') return text;
  }
  return '';
}

/**
 * Read a case-insensitive child element from a parsed XML object.
 * WeCom documents are PascalCase (`MsgType`) but some payloads are lowercase.
 * @param {Record<string, any> | null | undefined} node
 * @param {string} name
 * @returns {unknown}
 */
export function pickChild(node, name) {
  if (!node || typeof node !== 'object') return undefined;
  if (name in node) return node[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(node)) {
    if (key.toLowerCase() === lower) return node[key];
  }
  return undefined;
}

/**
 * Read the text of a (case-insensitive) child element.
 * @param {Record<string, any> | null | undefined} node
 * @param {string} name
 * @returns {string}
 */
export function childText(node, name) {
  return asText(pickChild(node, name));
}
