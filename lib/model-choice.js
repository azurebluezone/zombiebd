"use strict";
// Model choice is a preference, not a provider lock.
//
// An agent remembers the model it was configured with, but a provider can be
// removed, a key can expire, or a local server can be stopped. In that case the
// agent must keep working from whatever the live catalog can actually serve
// instead of failing on a name nothing answers.
//
// Nothing in this file knows a provider or a model name; the caller supplies
// the candidate list in preference order.

function chooseUsableModel(preferred, envModel, candidates) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const served = new Set(list);

  const want = String(preferred || "").trim();
  if (want && served.has(want)) return want;

  const env = String(envModel || "").trim();
  if (env && served.has(env)) return env;

  return list.length ? list[0] : "";
}

module.exports = { chooseUsableModel };
