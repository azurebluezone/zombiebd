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

module.exports = { normalizeText };
