/**
 * 🎯 SKILL.md Plugin MCP Tool
 * 
 * An MCP tool that reads/parses SKILL.md format files.
 * Usable internally (by our agents) AND externally (by other editors).
 * 
 * SKILL.md Format (industry standard):
 *   ---
 *   name: "skill-name"
 *   description: "Brief description"
 *   metadata:
 *     short-description: "..."
 *     author: "Anthropic | OpenAI | etc"
 *     source: "https://..."
 *   ---
 *   # Skill Name
 *   ... markdown content ...
 * 
 * This tool spreads the "skill kingdom" everywhere —
 * any editor that supports MCP can use our skills.
 */

// ─── Dependencies ──────────────────────────────────────────
// Pure Node.js — no npm install needed
const fs = require('fs');
const path = require('path');

// ─── Configuration ─────────────────────────────────────────
const SKILLS_ROOT = process.env.SKILLS_DIR || path.join(__dirname);
const SUPPORTED_FORMATS = ['SKILL.md', 'skill.md'];

// ─── Tool: list_skills ─────────────────────────────────────
// Lists all available skills with metadata
function listSkills() {
  const results = [];
  
  if (!fs.existsSync(SKILLS_ROOT)) {
    return { error: `Skills directory not found: ${SKILLS_ROOT}` };
  }
  
  const entries = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    const skillDir = path.join(SKILLS_ROOT, entry.name);
    const skillFile = findSkillFile(skillDir);
    
    if (!skillFile) continue;
    
    const parsed = parseSkillFile(skillFile);
    if (parsed) {
      results.push({
        name: parsed.name,
        description: parsed.description,
        shortDescription: parsed.metadata['short-description'] || '',
        author: parsed.metadata.author || 'unknown',
        source: parsed.metadata.source || '',
        path: skillFile,
      });
    }
  }
  
  return { skills: results, count: results.length };
}

// ─── Tool: read_skill ��─────────────────────────────────────
// Reads a specific skill's full content by name
function readSkill(skillName) {
  if (!skillName || typeof skillName !== 'string') {
    return { error: 'Skill name is required' };
  }
  
  const normalized = skillName.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const skillDir = path.join(SKILLS_ROOT, normalized);
  
  if (!fs.existsSync(skillDir)) {
    return { error: `Skill "${skillName}" not found` };
  }
  
  const skillFile = findSkillFile(skillDir);
  if (!skillFile) {
    return { error: `No SKILL.md found in ${skillDir}` };
  }
  
  const parsed = parseSkillFile(skillFile);
  if (!parsed) {
    return { error: `Failed to parse ${skillFile}` };
  }
  
  return parsed;
}

// ─── Tool: search_skills ───────────────────────────────────
// Searches skills by keyword (name, description, content)
function searchSkills(query) {
  if (!query || typeof query !== 'string') {
    return { error: 'Search query is required' };
  }
  
  const all = listSkills();
  if (all.error) return all;
  
  const q = query.toLowerCase();
  const matched = all.skills.filter(skill => {
    return (
      skill.name.toLowerCase().includes(q) ||
      skill.description.toLowerCase().includes(q) ||
      (skill.shortDescription || '').toLowerCase().includes(q)
    );
  });
  
  return { results: matched, count: matched.length, query };
}

// ─── Tool: install_skill ───────────────────────────────────
// Installs a skill from a SKILL.md file path or URI
// Can copy from external sources into our skills directory
function installSkill(sourcePath) {
  if (!sourcePath || typeof sourcePath !== 'string') {
    return { error: 'Source path is required' };
  }
  
  const resolvedPath = path.resolve(sourcePath);
  
  if (!fs.existsSync(resolvedPath)) {
    return { error: `Source not found: ${sourcePath}` };
  }
  
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile() && !stat.isDirectory()) {
    return { error: 'Source must be a file or directory' };
  }
  
  // If it's a directory, look for SKILL.md inside
  let srcFile = resolvedPath;
  if (stat.isDirectory()) {
    srcFile = findSkillFile(resolvedPath);
    if (!srcFile) {
      return { error: `No SKILL.md found in directory: ${sourcePath}` };
    }
  }
  
  const parsed = parseSkillFile(srcFile);
  if (!parsed) {
    return { error: `Failed to parse ${srcFile}` };
  }
  
  const skillName = parsed.name;
  const targetDir = path.join(SKILLS_ROOT, skillName);
  
  if (fs.existsSync(targetDir)) {
    return { error: `Skill "${skillName}" already exists` };
  }
  
  // Copy the skill file
  fs.mkdirSync(targetDir, { recursive: true });
  const targetFile = path.join(targetDir, 'SKILL.md');
  fs.copyFileSync(srcFile, targetFile);
  
  // Also copy associated files if source is a directory
  if (stat.isDirectory()) {
    const srcDir = resolvedPath;
    const entries = fs.readdirSync(srcDir);
    for (const entry of entries) {
      if (entry === 'SKILL.md' || entry === 'skill.md') continue;
      const srcEntry = path.join(srcDir, entry);
      const tgtEntry = path.join(targetDir, entry);
      const entryStat = fs.statSync(srcEntry);
      if (entryStat.isFile()) {
        fs.copyFileSync(srcEntry, tgtEntry);
      } else if (entryStat.isDirectory()) {
        copyDirRecursive(srcEntry, tgtEntry);
      }
    }
  }
  
  return {
    success: true,
    name: skillName,
    description: parsed.description,
    path: targetFile,
    message: `Skill "${skillName}" installed successfully`,
  };
}

// ─── Tool: skill_info ──────────────────────────────────────
// Returns info about what skills are available + how to use them
function skillInfo() {
  return {
    tool: 'SKILL.md Plugin MCP Tool',
    version: '1.0.0',
    description: 'MCP tool for reading/parsing SKILL.md format skills',
    formats: ['SKILL.md', 'skill.md'],
    commands: [
      { name: 'list_skills', description: 'List all available skills' },
      { name: 'read_skill', description: 'Read a specific skill by name', params: ['skillName'] },
      { name: 'search_skills', description: 'Search skills by keyword', params: ['query'] },
      { name: 'install_skill', description: 'Install a skill from a source path', params: ['sourcePath'] },
    ],
    usage: 'Call these via MCP. Works internally (agents) + externally (editors).',
  };
}

// ─── Helpers ──────────────────────────────────���───────────

function findSkillFile(dirPath) {
  for (const fmt of SUPPORTED_FORMATS) {
    const filePath = path.join(dirPath, fmt);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

function parseSkillFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseSkillContent(content, filePath);
  } catch (err) {
    return null;
  }
}

function parseSkillContent(content, filePath) {
  // Normalize line endings first (handle CRLF too)
  const normalized = content.replace(/\r\n/g, '\n');
  
  // Parse YAML frontmatter
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    // No frontmatter — treat whole file as markdown
    return {
      name: path.basename(path.dirname(filePath)),
      description: '',
      metadata: {},
      content: content.trim(),
      filePath,
      format: 'markdown-only',
    };
  }
  
  const frontmatterStr = match[1];
  const markdownContent = match[2].trim();
  
  const parsed = {
    raw: frontmatterStr,
    name: '',
    description: '',
    metadata: {},
    content: markdownContent,
    filePath,
    format: 'skill-md',
  };
  
  // Parse YAML-like frontmatter (simple parser, no yaml deps)
  const lines = frontmatterStr.split('\n').filter(l => l.trim());
  let currentKey = null;
  let currentIndent = 0;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    // Check indentation for nested structure
    const indent = line.search(/\S/);
    
    if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.substring(0, colonIdx).trim();
      let value = trimmed.substring(colonIdx + 1).trim();
      
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      if (indent === 0) {
        // Top-level key
        if (key === 'name') parsed.name = value;
        else if (key === 'description') parsed.description = value;
        else if (key === 'license') parsed.metadata.license = value;
        else {
          currentKey = key;
          if (typeof parsed.metadata[key] === 'undefined') {
            parsed.metadata[key] = {};
          }
          currentIndent = indent;
        }
      } else if (indent > 0 && currentKey) {
        // Nested key (metadata fields)
        if (typeof parsed.metadata[currentKey] === 'object' && !Array.isArray(parsed.metadata[currentKey])) {
          parsed.metadata[currentKey][key] = value;
        } else {
          parsed.metadata[key] = value;
        }
      }
    }
  }
  
  // Fallback: use folder name if no name in frontmatter
  if (!parsed.name) {
    parsed.name = path.basename(path.dirname(filePath));
  }
  
  return parsed;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ─── MCP Handler ───────────────────────────────────────────
// Processes incoming MCP requests for skill operations
function handleMCPRequest(request) {
  const { method, params } = request;
  
  switch (method) {
    case 'list_skills':
      return listSkills();
    
    case 'read_skill':
      return readSkill(params?.skillName);
    
    case 'search_skills':
      return searchSkills(params?.query);
    
    case 'install_skill':
      return installSkill(params?.sourcePath);
    
    case 'skill_info':
      return skillInfo();
    
    default:
      return { error: `Unknown method: ${method}` };
  }
}

// ─── Exports ──────────────────────────────────��────────────
module.exports = {
  listSkills,
  readSkill,
  searchSkills,
  installSkill,
  skillInfo,
  handleMCPRequest,
  parseSkillContent,
};

// ─── CLI Usage ─────────────────────────────────────────────
// Run directly: node skill-mcp-tool.js list_skills
// Run with args: node skill-mcp-tool.js read_skill jupyter-notebook
if (require.main === module) {
  const method = process.argv[2] || 'skill_info';
  const param = process.argv[3];
  
  const request = {
    method,
    params: param ? { skillName: param, query: param, sourcePath: param } : {},
  };
  
  const result = handleMCPRequest(request);
  console.log(JSON.stringify(result, null, 2));
}
