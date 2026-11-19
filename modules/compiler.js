"use strict";

// Compile pass: real node --check / JSON.parse, never a regex.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const JS_EXT = new Set([".js", ".cjs", ".mjs"]);

class CompileInputError extends Error {
  constructor(detail) {
    super(detail);
    this.name = "CompileInputError";
    this.code = "ZC_COMPILE_INPUT";
  }
}

function compileOne(file, cwd, timeoutMs) {
  const abs = path.resolve(cwd, file);
  const ext = path.extname(abs).toLowerCase();
  if (!fs.existsSync(abs)) {
    return { file, ok: false, error: "missing file" };
  }
  if (JS_EXT.has(ext)) {
    const run = spawnSync(process.execPath, ["--check", abs], {
      timeout: timeoutMs,
      encoding: "utf8",
    });
    const ok = run.status === 0;
    return {
      file,
      ok,
      parser: "node --check",
      error: ok ? "" : String(run.stderr || run.stdout || "").trim().slice(0, 500),
    };
  }
  if (ext === ".json") {
    try {
      JSON.parse(fs.readFileSync(abs, "utf8"));
      return { file, ok: true, parser: "JSON.parse", error: "" };
    } catch (error) {
      return { file, ok: false, parser: "JSON.parse", error: String(error.message).slice(0, 500) };
    }
  }
  return { file, ok: true, skipped: true, parser: "none" };
}

/**
 * @param {string[]} files paths relative to cwd (or absolute)
 * @param {{cwd?: string, timeoutMs?: number}} [opts]
 */
function compileFiles(files, opts) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new CompileInputError("compileFiles needs a non-empty file list");
  }
  const o = opts || {};
  const cwd = path.resolve(o.cwd || process.cwd());
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 20000;
  const results = files.map((file) => compileOne(String(file), cwd, timeoutMs));
  return {
    passed: results.every((result) => result.ok),
    results,
    compiled: results.filter((result) => !result.skipped).length,
    skipped: results.filter((result) => result.skipped).length,
  };
}

function containsCodeBlock(text) {
  return (
    /```[\s\S]*?```/.test(text) ||
    /\b(function|const|let|var|import|export|def |class |async)\b/.test(text)
  );
}

function hasDangerousPatterns(text) {
  return /\b(eval|exec|spawn|child_process|rm -rf|process\.exit|fs\.rmSync)\b/i.test(
    text,
  );
}

// ══════════════════════════════════════════════════════════════
//  COMPILER CHECK — Code Verification
// ══════════════════════════════════════════════════════════════
// Checks agent output for code syntax, dependency references,
// security patterns, and path validity.
async function analyzeContent(content, language, context, transport) {
  if (!containsCodeBlock(content)) {
    return { passed: true, skipped: true, reason: "No code in response" };
  }

  transport.stream({
    type: "compiler_check_start",
    language: language || "auto-detected",
  });

  const checks = [];
  const codeBlocks = extractCodeBlocks(content);

  // Syntax check for each code block
  for (const block of codeBlocks) {
    const syntaxIssues = checkBasicSyntax(block.code, block.language);
    checks.push({
      block: block.language,
      check: "syntax",
      passed: syntaxIssues.length === 0,
      errors: syntaxIssues,
    });
    transport.stream({
      type: "compiler_check_result",
      block: block.language,
      check: "syntax",
      status: syntaxIssues.length === 0 ? "PASSED" : "FAILED",
      errors: syntaxIssues,
    });
  }

  // Dependency check (against SSOT if available)
  if (context?.ssot) {
    const depIssues = checkDependenciesInCode(codeBlocks, context.ssot);
    for (const issue of depIssues) {
      checks.push({
        check: "dependency",
        passed: issue.passed,
        detail: issue.detail,
      });
      transport.stream({
        type: "compiler_check_result",
        check: "dependency",
        status: issue.passed ? "PASSED" : "WARNING",
        detail: issue.detail,
      });
    }
  }

  // Security pattern check
  const dangerousPatterns = hasDangerousPatterns(content);
  checks.push({
    check: "security",
    passed: !dangerousPatterns,
    warnings: dangerousPatterns ? ["Dangerous pattern detected"] : [],
  });
  transport.stream({
    type: "compiler_check_result",
    check: "security",
    status: dangerousPatterns ? "FAILED" : "PASSED",
  });

  const allPassed = checks.every((c) => c.passed);
  transport.stream({
    type: "compiler_check_done",
    result: allPassed ? "ALL_PASSED" : "SOME_FAILED",
    passedCount: checks.filter((c) => c.passed).length,
    totalCount: checks.length,
    severity: allPassed ? "info" : "warning",
  });

  return { passed: allPassed, checks };
}

// ─── Compiler Check Helpers ──────────────────────────────────

function extractCodeBlocks(text) {
  const blocks = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      language: match[1] || "unknown",
      code: match[2],
    });
  }
  return blocks;
}

function checkBasicSyntax(code, language) {
  const issues = [];
  const lines = code.split("\n");
  const lang = language.toLowerCase();

  // JavaScript/TypeScript basic checks
  if (["js", "javascript", "ts", "typescript", "jsx", "tsx"].includes(lang)) {
    let parenCount = 0;
    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;
    let stringChar = null;

    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      const prev = i > 0 ? code[i - 1] : "";

      if (!inString) {
        if (ch === '"' || ch === "'" || ch === "`") {
          inString = true;
          stringChar = ch;
        } else if (ch === "(") parenCount++;
        else if (ch === ")") parenCount--;
        else if (ch === "{") braceCount++;
        else if (ch === "}") braceCount--;
        else if (ch === "[") bracketCount++;
        else if (ch === "]") bracketCount--;
      } else if (ch === stringChar && prev !== "\\") {
        inString = false;
        stringChar = null;
      }
    }

    if (parenCount !== 0) issues.push("Unmatched parentheses: " + parenCount);
    if (braceCount !== 0) issues.push("Unmatched braces: " + braceCount);
    if (bracketCount !== 0) issues.push("Unmatched brackets: " + bracketCount);
  }

  // Python basic checks
  if (["py", "python"].includes(lang)) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.endsWith(":") && !trimmed.startsWith("#")) {
        const nextLine = lines
          .slice(i + 1)
          .find((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
        if (nextLine && !nextLine.startsWith(" ")) {
          issues.push(
            "Line " +
            (i + 2) +
            ": Expected indented block after '" +
            trimmed +
            "'",
          );
        }
      }
    }
  }

  return issues;
}

function checkDependenciesInCode(codeBlocks, ssotContent) {
  const issues = [];
  if (!ssotContent) return issues;

  for (const block of codeBlocks) {
    const imports = block.code.match(
      /require\(['"]([^'"]+)['"]\)|from\s+['"]([^'"]+)['"]/g,
    );
    if (imports) {
      for (const imp of imports) {
        const lib = imp.replace(/require\(|from\s+|['"]/g, "");
        if (lib.startsWith(".") || lib.startsWith("/")) {
          if (!ssotContent.includes(lib.replace("./", ""))) {
            issues.push({
              passed: false,
              detail: "Potential missing dependency: " + lib,
            });
          }
        }
      }
    }
  }

  return issues;
}


module.exports = {
  CompileInputError,
  compileFiles,
  analyzeContent,
  containsCodeBlock,
  hasDangerousPatterns,
  extractCodeBlocks,
  checkBasicSyntax,
  checkDependenciesInCode,
};
