#!/usr/bin/env node
"use strict";

// Live gateway acceptance check for the provider activation.
// Real HTTP only: no provider mocks and no imports from the source tree.
//
// Contract: gc-mwh77jeu — prints PROVIDER_LIVE_OK only when every
// requirement in the recorded pass criteria holds on the running gateway.

const BASE = (process.env.PROVIDER_LIVE_BASE || "http://localhost:5050").replace(/\/+$/, "");
const EXPECTED_AGENT_TEXT = /GATEWAY_OK/i;

const REQUIRED_MODELS = [
  { id: "openai/gpt-oss-20b", provider: "groq" },
  { id: "gemini-3.5-flash", provider: "gemini" },
  { id: "nvidia/nemotron-3.5-bolt-e4b", provider: "custom_1", providerName: "nvidia" },
  { id: "lfm3:1.7b", provider: "ollama" },
];

function die(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function describe(row) {
  return `${row.id} [provider=${row.provider}]`;
}

async function getJson(pathname, timeoutMs) {
  const response = await fetch(`${BASE}${pathname}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

async function postChat(payload, timeoutMs) {
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ stream: false, ...payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

async function waitForHealth() {
  let last = "unreachable";
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
      if (response.status === 200) return 200;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error?.cause?.code || error?.name || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return last;
}

async function main() {
  const health = await waitForHealth();
  if (health !== 200) die(`/health not ready at ${BASE} (last=${health})`);
  console.log(`OK   /health 200 (${BASE})`);

  const catalog = await getJson("/api/v1/models", 15000);
  if (catalog.status !== 200 || !catalog.body || !Array.isArray(catalog.body.data)) {
    die(`/api/v1/models status=${catalog.status} body=${catalog.text.slice(0, 300)}`);
  }
  const rows = catalog.body.data;
  console.log(`OK   /api/v1/models rows=${rows.length}`);

  const opencodeRows = rows.filter((row) => String(row.provider || "").toLowerCase() === "opencode");
  if (opencodeRows.length > 0) {
    die(`opencode still advertised: ${opencodeRows.slice(0, 5).map(describe).join(", ")}`);
  }
  console.log("OK   no provider=opencode rows");

  for (const want of REQUIRED_MODELS) {
    const candidates = rows.filter((row) => String(row.id) === want.id);
    const match = candidates.find(
      (row) =>
        String(row.provider) === want.provider ||
        (want.providerName && String(row.providerName || "").toLowerCase() === want.providerName),
    );
    if (!match) {
      die(
        `missing ${want.id} from ${want.providerName || want.provider}; saw ` +
          `${candidates.map(describe).join(", ") || "none"}`,
      );
    }
    console.log(`OK   ${want.id} provider=${match.provider} (${match.providerName || ""})`);
  }

  // The disabled provider must not resolve a model anymore.
  const blocked = await postChat(
    { model: "claude-opus-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
    15000,
  );
  if (blocked.status !== 400) {
    die(`opencode-only model resolved: HTTP ${blocked.status} ${blocked.text.slice(0, 200)}`);
  }
  console.log("OK   opencode-only model rejected (HTTP 400)");

  // The agent path must still answer end to end.
  let status = 0;
  let content = "";
  for (let attempt = 1; attempt <= 2 && !content; attempt += 1) {
    const chat = await postChat(
      {
        model: "code-guru",
        messages: [{ role: "user", content: "Reply with exactly: GATEWAY_OK" }],
        max_tokens: 256,
        temperature: 0,
      },
      60000,
    );
    status = chat.status;
    content = String(chat.body?.choices?.[0]?.message?.content ?? "").trim();
    if (status !== 200 || !content) {
      console.error(`WARN code-guru attempt ${attempt}: HTTP ${status} ${chat.text.slice(0, 200)}`);
    }
  }
  if (status !== 200 || !content) die(`code-guru did not answer (HTTP ${status})`);
  if (!EXPECTED_AGENT_TEXT.test(content)) {
    die(`code-guru answered without GATEWAY_OK: ${content.slice(0, 200)}`);
  }
  console.log(`OK   code-guru answered: ${content.slice(0, 120)}`);

  console.log("PROVIDER_LIVE_OK");
}

main().catch((error) => die(String(error?.stack || error)));
