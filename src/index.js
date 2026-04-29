#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_REPO = "Luan-X/Geosite2Surge";
const DEFAULT_BRANCH = "main";
const DEFAULT_UPSTREAM = "https://github.com/v2fly/domain-list-community";
const VALID_LIST_NAME = /^[a-z0-9!_-]+$/i;

const RULE_TYPES = new Map([
  ["domain", "DOMAIN-SUFFIX"],
  ["full", "DOMAIN"],
  ["keyword", "DOMAIN-KEYWORD"],
  ["regexp", "DOMAIN-WILDCARD"]
]);

export function buildGeosite2Surge(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const dataDir = path.resolve(cwd, options.dataDir ?? process.env.GEOSITE_DATA_DIR ?? "domain-list-community/data");
  const outDir = path.resolve(cwd, options.outDir ?? process.env.OUT_DIR ?? "data");
  const readmePath = path.resolve(cwd, options.readme ?? "README.md");
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO;
  const branch = options.branch ?? process.env.GITHUB_REF_NAME ?? DEFAULT_BRANCH;
  const rawBaseUrl = options.rawBaseUrl ?? makeDefaultRawBaseUrl(cwd, outDir, repo, branch);
  const writeReadme = options.writeReadme ?? true;

  const sources = loadSourceLists(dataDir);
  prepareOutputDirectory(outDir, dataDir);

  const converter = new Converter(sources);
  const sourceNames = sortNames([...sources.keys()]);
  const generatedNames = new Set(sourceNames);
  let ruleCount = 0;

  for (const name of sourceNames) {
    const lines = converter.emitList(name);
    ruleCount += countRuleLines(lines);
    writeOutputFile(outDir, name, lines);
  }

  const attributeFiles = converter.collectAttributeFiles();
  for (const [name, lines] of sortEntries(attributeFiles)) {
    if (sources.has(name)) {
      continue;
    }

    generatedNames.add(name);
    ruleCount += countRuleLines(lines);
    writeOutputFile(outDir, name, lines);
  }

  const names = sortNames([...generatedNames]);
  if (writeReadme) {
    fs.writeFileSync(
      readmePath,
      makeReadme({
        names,
        rawBaseUrl,
        upstreamUrl: DEFAULT_UPSTREAM
      }),
      "utf8"
    );
  }

  return {
    dataDir,
    outDir,
    readmePath,
    files: names.length,
    rules: ruleCount,
    sourceFiles: sourceNames.length,
    attributeFiles: [...attributeFiles.keys()].filter((name) => !sources.has(name)).length
  };
}

export function loadSourceLists(dataDir) {
  if (!fs.existsSync(dataDir)) {
    throw new Error(`geosite data directory not found: ${dataDir}`);
  }

  const sources = new Map();
  const entries = fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(compareNames);

  for (const fileName of entries) {
    const name = normalizeListName(fileName);
    const filePath = path.join(dataDir, fileName);
    const content = fs.readFileSync(filePath, "utf8");
    sources.set(name, parseListText(name, content));
  }

  return sources;
}

export function parseListText(listName, content) {
  const normalizedName = normalizeListName(listName);
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalizedContent.split("\n");
  const entries = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    if (index === rawLines.length - 1 && raw === "") {
      continue;
    }

    entries.push(parseLine(normalizedName, raw, index + 1));
  }

  return entries;
}

export function regexToWildcard(pattern) {
  const singleChar = "\u0000";
  let wildcard = pattern.trim();
  wildcard = wildcard.replace(/^\/|\/$/g, "");
  wildcard = wildcard.replace(/^\^/, "").replace(/\$$/, "");
  wildcard = wildcard.replace(/\(\^\|\\\.\)/g, "*");
  wildcard = wildcard.replace(/\^\|\\\./g, "*");
  wildcard = wildcard.replace(/\.\+/g, "*");
  wildcard = wildcard.replace(/\.\*/g, "*");
  wildcard = wildcard.replace(/\\\./g, ".");
  wildcard = wildcard.replace(/\\-/g, "-");
  wildcard = wildcard.replace(/\\_/g, "_");
  wildcard = wildcard.replace(/\\\//g, "/");
  wildcard = wildcard.replace(/\\[dDsSwW](\{[^}]+\}|[+*?])?/g, (_match, quantifier) =>
    quantifier ? "*" : singleChar
  );
  wildcard = wildcard.replace(/\[[^\]]+\](\{[^}]+\}|[+*?])?/g, (_match, quantifier) =>
    quantifier ? "*" : singleChar
  );
  wildcard = wildcard.replace(/\((?:\?:)?[^)]*\)(?:\{[^}]+\}|[+*?])?/g, "*");
  wildcard = wildcard.replace(/\{[^}]+\}/g, "*");
  wildcard = wildcard.replace(/[+?]/g, "*");
  wildcard = wildcard.replace(/\\(.)/g, "$1");
  wildcard = wildcard.replace(/[|()[\]{}^$]/g, "*");
  wildcard = wildcard.replace(/\*+/g, "*");
  wildcard = wildcard.replaceAll(singleChar, "?");
  wildcard = wildcard.replace(/^\*\./, "*.");
  wildcard = wildcard.replace(/,\s*/g, "");
  wildcard = wildcard.trim();

  return wildcard.length > 0 ? wildcard : "*";
}

class Converter {
  constructor(sources) {
    this.sources = sources;
    this.cache = new Map();
  }

  emitList(name, filter = emptyFilter(), stack = []) {
    const normalizedName = normalizeListName(name);
    const cacheKey = `${normalizedName}|${filterKey(filter)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return [...cached];
    }

    if (stack.includes(normalizedName)) {
      throw new Error(`cyclic include detected: ${[...stack, normalizedName].join(" -> ")}`);
    }

    const entries = this.sources.get(normalizedName);
    if (!entries) {
      throw new Error(`included geosite list not found: ${normalizedName}`);
    }

    const lines = [];
    const nextStack = [...stack, normalizedName];
    const filtering = !isEmptyFilter(filter);

    for (const entry of entries) {
      if (entry.kind === "blank") {
        if (!filtering) {
          lines.push("");
        }
        continue;
      }

      if (entry.kind === "comment") {
        if (!filtering) {
          lines.push(entry.value);
        }
        continue;
      }

      if (entry.kind === "include") {
        const childFilter = mergeFilter(filter, entry.attrs);
        const childLines = this.emitList(entry.name, childFilter, nextStack);
        lines.push(`#include:${entry.name}${formatAttrs(entry.attrs)}`);
        lines.push(...childLines);
        lines.push(`#end include:${entry.name}`);
        continue;
      }

      if (matchesFilter(entry.attrs, filter)) {
        lines.push(formatRule(entry, { keepComment: true }));
      }
    }

    this.cache.set(cacheKey, lines);
    return [...lines];
  }

  collectAttributeFiles() {
    const files = new Map();

    for (const entries of this.sources.values()) {
      for (const entry of entries) {
        if (entry.kind !== "rule") {
          continue;
        }

        for (const attr of entry.attrs) {
          if (attr.startsWith("-")) {
            continue;
          }

          if (!files.has(attr)) {
            files.set(attr, []);
          }

          files.get(attr).push(formatRule(entry, { keepComment: false }));
        }
      }
    }

    for (const [name, lines] of files) {
      files.set(name, dedupe(lines));
    }

    return files;
  }
}

function parseLine(listName, raw, lineNumber) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "blank", source: { list: listName, line: lineNumber } };
  }

  if (trimmed.startsWith("#")) {
    return {
      kind: "comment",
      value: trimmed,
      source: { list: listName, line: lineNumber }
    };
  }

  const { body, comment } = splitComment(raw);
  const parts = body.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return {
      kind: "comment",
      value: comment ? `#${comment}` : "#",
      source: { list: listName, line: lineNumber }
    };
  }

  const token = parts[0];
  const attrs = parseAttrs(parts.slice(1), listName, lineNumber);
  const colonIndex = token.indexOf(":");
  const type = colonIndex === -1 ? "domain" : token.slice(0, colonIndex).toLowerCase();
  const value = colonIndex === -1 ? token : token.slice(colonIndex + 1);

  if (type === "include") {
    return {
      kind: "include",
      name: normalizeListName(value),
      attrs,
      comment,
      source: { list: listName, line: lineNumber }
    };
  }

  if (!RULE_TYPES.has(type)) {
    throw new Error(`invalid rule type "${type}" in ${listName}:${lineNumber}`);
  }

  return {
    kind: "rule",
    type,
    value: type === "regexp" ? value : value.toLowerCase(),
    attrs,
    comment,
    source: { list: listName, line: lineNumber }
  };
}

function splitComment(raw) {
  const commentIndex = raw.indexOf("#");
  if (commentIndex === -1) {
    return { body: raw, comment: "" };
  }

  return {
    body: raw.slice(0, commentIndex),
    comment: raw.slice(commentIndex + 1).trim()
  };
}

function parseAttrs(parts, listName, lineNumber) {
  const attrs = [];

  for (const part of parts) {
    if (part.startsWith("@")) {
      const attr = part.slice(1).toLowerCase();
      if (!VALID_LIST_NAME.test(attr)) {
        throw new Error(`invalid attribute "${attr}" in ${listName}:${lineNumber}`);
      }
      attrs.push(attr);
      continue;
    }

    if (part.startsWith("&")) {
      continue;
    }

    throw new Error(`invalid attribute token "${part}" in ${listName}:${lineNumber}`);
  }

  return attrs;
}

function formatRule(entry, options) {
  const ruleType = RULE_TYPES.get(entry.type);
  const value = entry.type === "regexp" ? regexToWildcard(entry.value) : entry.value;
  const comment = options.keepComment && entry.comment ? `    #${entry.comment}` : "";
  return `${ruleType},${value}${comment}`;
}

function emptyFilter() {
  return { must: [], ban: [] };
}

function mergeFilter(filter, attrs) {
  const next = {
    must: [...filter.must],
    ban: [...filter.ban]
  };

  for (const attr of attrs) {
    if (attr.startsWith("-")) {
      next.ban.push(attr.slice(1));
    } else {
      next.must.push(attr);
    }
  }

  return {
    must: dedupe(next.must).sort(compareNames),
    ban: dedupe(next.ban).sort(compareNames)
  };
}

function matchesFilter(attrs, filter) {
  if (isEmptyFilter(filter)) {
    return true;
  }

  const attrSet = new Set(attrs);
  return filter.must.every((attr) => attrSet.has(attr)) && filter.ban.every((attr) => !attrSet.has(attr));
}

function filterKey(filter) {
  return `${filter.must.join(",")}|-${filter.ban.join(",")}`;
}

function isEmptyFilter(filter) {
  return filter.must.length === 0 && filter.ban.length === 0;
}

function formatAttrs(attrs) {
  if (attrs.length === 0) {
    return "";
  }

  return ` ${attrs.map((attr) => `@${attr}`).join(" ")}`;
}

function normalizeListName(name) {
  const normalized = name.trim().toLowerCase();
  if (!VALID_LIST_NAME.test(normalized)) {
    throw new Error(`invalid geosite list name: ${name}`);
  }
  return normalized;
}

function prepareOutputDirectory(outDir, dataDir) {
  const resolvedOut = path.resolve(outDir);
  const resolvedData = path.resolve(dataDir);
  const root = path.parse(resolvedOut).root;

  if (resolvedOut === root || resolvedOut === os.homedir()) {
    throw new Error(`refuse to clean unsafe output directory: ${resolvedOut}`);
  }

  if (resolvedOut === resolvedData) {
    throw new Error("output directory must be different from geosite data directory");
  }

  fs.rmSync(resolvedOut, { recursive: true, force: true });
  fs.mkdirSync(resolvedOut, { recursive: true });
}

function writeOutputFile(outDir, name, lines) {
  fs.writeFileSync(path.join(outDir, name), `${lines.join("\n")}\n`, "utf8");
}

function makeDefaultRawBaseUrl(cwd, outDir, repo, branch) {
  let outPath = path.relative(cwd, outDir).split(path.sep).join("/");
  if (outPath.startsWith("..")) {
    outPath = path.basename(outDir);
  }

  return `https://raw.githubusercontent.com/${repo}/refs/heads/${branch}/${outPath}`;
}

function makeReadme({ names, rawBaseUrl, upstreamUrl }) {
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const lines = [
    "# Geosite2Surge",
    "Geosite to Surge rule converter",
    "",
    `Upstream: ${upstreamUrl}`,
    "",
    "## Usage",
    "```",
    "geosite:google",
    `RULE-SET,${baseUrl}/google,PROXY`,
    "geosite:xxxxxx",
    `RULE-SET,${baseUrl}/xxxxxx,PROXY`,
    "```",
    "",
    "## Rules",
    "| geosite name | surge config url |",
    "|--------------|------------------|"
  ];

  for (const name of names) {
    lines.push(`| ${name} | ${baseUrl}/${encodeURI(name)} |`);
  }

  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--data-dir") {
      options.dataDir = readValue();
    } else if (arg === "--out-dir") {
      options.outDir = readValue();
    } else if (arg === "--readme") {
      options.readme = readValue();
    } else if (arg === "--repo") {
      options.repo = readValue();
    } else if (arg === "--branch") {
      options.branch = readValue();
    } else if (arg === "--raw-base-url") {
      options.rawBaseUrl = readValue();
    } else if (arg === "--no-readme") {
      options.writeReadme = false;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node src/index.js [options]

Options:
  --data-dir <path>      v2fly/domain-list-community data directory
  --out-dir <path>       output directory for Surge rule files
  --repo <owner/name>    GitHub repository used in README raw URLs
  --branch <name>        branch used in README raw URLs
  --raw-base-url <url>   explicit base URL for generated rule files
  --readme <path>        README path to update
  --no-readme            skip README generation
  --quiet                suppress summary output
`);
}

function countRuleLines(lines) {
  return lines.filter((line) => /^DOMAIN(?:-|,)/.test(line)).length;
}

function dedupe(values) {
  return [...new Set(values)];
}

function sortNames(names) {
  return names.sort(compareNames);
}

function sortEntries(map) {
  return [...map.entries()].sort(([left], [right]) => compareNames(left, right));
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}

function isMainModule() {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }

    const result = buildGeosite2Surge(options);
    if (!options.quiet) {
      console.log(
        `Converted ${result.sourceFiles} source files into ${result.files} Surge rule files (${result.rules} rules).`
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
