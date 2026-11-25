"use strict";

// Which provider errors are really about ONE model?
//
// A 400 is a request-shape problem (context length, bad parameter) and a 404
// that names the model is a catalog problem. Neither says the provider is sick.
// Counting them as provider-wide failures tripped the 3-strike breaker on
// retired Gemini ids, then skipped every healthy model on that provider for the
// whole cooldown window. The caller still falls through to the next provider;
// it just does not poison the health ledger.
function isModelScopedProviderError(statusCode, errorMessage) {
  const status = Number(statusCode) || 0;
  if (status === 400) return true;
  if (status !== 404) return false;
  return /model|no longer available|does not exist|not available to new users|unsupported/i.test(
    String(errorMessage || ""),
  );
}

module.exports = { isModelScopedProviderError };