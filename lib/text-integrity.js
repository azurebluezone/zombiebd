"use strict";

/*
 * Bengali-safe text cleanup.
 *
 * Canonical normalization plus the invisible-character rules that used to
 * live inline in api.js. Kept as a module so the byte behaviour is testable:
 *   - NFC puts canonically equivalent spellings on one byte sequence.
 *     Bengali nukta letters are Unicode composition exclusions, so NFC does
 *     NOT return U+09DC/09DD/09DF: rra stays U+09A1 U+09BC, rha stays
 *     U+09A2 U+09BC and yya stays U+09AF U+09BC. Forcing the precomposed
 *     character would change bytes away from the canonical form.
 *   - ZWNJ (U+200C) is preserved for Bengali/Devanagari conjuncts.
 *   - ZWJ (U+200D) is preserved between Indic characters and stripped when it
 *     is used as a watermark after Latin text.
 *   - Zero-width space, BOM, soft hyphen, bidi marks and U+FFFD are removed.
 */

// Unambiguous invisible characters: watermarks, BOM, bidi controls,
// non-characters and tag characters. ZWNJ/ZWJ are NOT here because Bengali
// and Devanagari conjuncts legitimately need them.
const INVISIBLE_RE =
  /[\u00AD\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFFD\uFDD0-\uFDEF\uFFFE\uFFFF]|[\u{E0000}-\u{E007F}]/gu;

function stripInvisible(text) {
  if (typeof text !== "string") return text;
  return text.replace(INVISIBLE_RE, "");
}

function scanInvisible(text) {
  const counts = {};
  if (typeof text !== "string") return counts;
  const re = new RegExp(INVISIBLE_RE.source, "gu");
  let match;
  while ((match = re.exec(text))) {
    const cp = match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    counts[cp] = (counts[cp] || 0) + 1;
  }
  return counts;
}

function normalizeText(text) {
  if (typeof text !== "string") return text;

  const hasBengali = /[\u0980-\u09FF]/.test(text);
  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  const isIndicScript = hasBengali || hasDevanagari;

  let cleaned = text
    .normalize("NFC")
    .replace(/\uFFFD/g, "")
    .replace(/\u200B/g, "")
    .replace(/\uFEFF/g, "")
    .replace(/\u2060/g, "")
    .replace(/\u2061/g, "")
    .replace(/\u2062/g, "")
    .replace(/\u2063/g, "")
    .replace(/\u2064/g, "")
    .replace(/\u180E/g, "")
    .replace(/\u00AD/g, "")
    .replace(/\u200E/g, "")
    .replace(/\u200F/g, "");

  if (!isIndicScript) {
    cleaned = cleaned.replace(/\u200C/g, "").replace(/\u200D/g, "");
  } else {
    cleaned = cleaned.replace(/(\u200D)(?![\u0980-\u09FF])/g, "");
  }

  return cleaned;
}

module.exports = { normalizeText, stripInvisible, scanInvisible, INVISIBLE_RE };
