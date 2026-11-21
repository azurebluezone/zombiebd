#!/usr/bin/env node
"use strict";

/**
 * scripts/caddy-render.js — CLI wrapper around modules/edge-proxy.js.
 *
 * The renderer lives in one place. This script keeps the existing
 * `--out` contract used by deploy/install-edge.sh and prints the same
 * CADDY_RENDER_OK marker.
 *
 *   node scripts/caddy-render.js                 # stdout
 *   node scripts/caddy-render.js --out FILE      # write FILE
 */

const fs = require("fs");
const path = require("path");
const edge = require("../modules/edge-proxy");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : "";
}

function main() {
  const outFile = argValue("--out");
  let config;
  let content;
  try {
    config = edge.resolveEdgeConfig({ root: path.resolve(__dirname, "..") });
    content = edge.renderCaddy(config);
  } catch (error) {
    const marker = error.code === "ENV_FAIL" ? "ENV_FAIL" : "CADDY_RENDER_FAIL";
    process.stderr.write(marker + " " + error.message + "\n");
    process.exit(1);
  }

  const sites = (content.match(/^https:\/\//gm) || []).length;
  if (outFile) {
    const target = path.resolve(outFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    console.log("CADDY_RENDER_OK sites=" + sites + " out=" + target);
    return;
  }
  process.stdout.write(content);
  process.stderr.write("CADDY_RENDER_OK sites=" + sites + "\n");
}

main();
