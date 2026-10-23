import fs from "node:fs";
import path from "node:path";
import { guides, sharedEnv } from "../web/public/docs/coding-agents/guide-data.js";

const root = path.resolve(import.meta.dirname, "..");
const agents = {
  "codex-cli": "codex",
  "cursor-cli": "cursor",
  "claude-cli": "claude",
  "antigravity-cli": "antigravity",
};
const sharedVariables = sharedEnv.map(([name]) => name);
// These checks intentionally mirror the connectors' current configuration
// idioms. Update the matchers if environment access or command dispatch is
// refactored away from os.environ.get/os.getenv and `cmd == "/command"`.
const envRead = /os\.(?:environ\.get|getenv)\(\s*(["'])([A-Z0-9_]+)\1(?:\s*,\s*(["'])(.*?)\3)?/g;
const indexedEnvRead = /os\.environ\s*\[\s*(["'])([A-Z0-9_]+)\1\s*\]/g;
const commandRead = /cmd\s*==\s*(["'])(\/[a-z][a-z0-9-]*)\1/g;
const ignoredLiteralDefaults = new Set([
  "AGORA_PAIRING_TOKEN", "AGENT_ID", "AGENT_NAME", "AGENT_AVATAR", "STATE_FILE",
]);
const displayedDefault = value => {
  const normalized = value.replace(/^Empty(?: \(.*\))?$/, "");
  return normalized === "—" ? null : normalized;
};
let failed = false;

for (const [directory, guideKey] of Object.entries(agents)) {
  const source = fs.readFileSync(path.join(root, "bridges", directory, "bridge.py"), "utf8");
  const reads = [...source.matchAll(envRead)];
  const indexedReads = [...source.matchAll(indexedEnvRead)];
  const implemented = new Set([
    ...reads.map(match => match[2]),
    ...indexedReads.map(match => match[2]),
  ]);
  const documentedRows = [...sharedEnv, ...guides[guideKey].env];
  const documented = new Set(documentedRows.map(([name]) => name));
  const missing = [...implemented].filter(variable => !documented.has(variable));
  const stale = [...documented].filter(variable => !implemented.has(variable));
  const invalidRequirements = documentedRows
    .filter(([, requirement]) => !["Required", "Required*", "Recommended", "Optional"].includes(requirement))
    .map(([name]) => name);
  const documentedDefaults = new Map(
    documentedRows.map(([name, , fallback]) => [name, displayedDefault(fallback)]),
  );
  const wrongDefaults = reads.flatMap(match => {
    const [, , variable, , literalDefault] = match;
    if (literalDefault === undefined || ignoredLiteralDefaults.has(variable)) return [];
    const documentedDefault = documentedDefaults.get(variable);
    const followingSource = source.slice(match.index + match[0].length, match.index + match[0].length + 80);
    const booleanFromEmpty = literalDefault === ""
      && /^\s*\)\.lower\(\)\s+in\s+\(/.test(followingSource);
    const effectiveDefault = booleanFromEmpty ? "0" : literalDefault;
    return documentedDefault === effectiveDefault
      ? []
      : [`${variable} (code: ${JSON.stringify(effectiveDefault)}, guide: ${JSON.stringify(documentedDefault)})`];
  });
  const implementedCommands = new Set([...source.matchAll(commandRead)].map(match => match[2]));
  const documentedCommands = new Set(
    guides[guideKey].commands.map(([command]) => command.split(/\s/, 1)[0]),
  );
  const missingCommands = [...implementedCommands].filter(command => !documentedCommands.has(command));
  const staleCommands = [...documentedCommands].filter(command => !implementedCommands.has(command));

  if (missing.length || stale.length || invalidRequirements.length || wrongDefaults.length
      || missingCommands.length || staleCommands.length) {
    failed = true;
    if (missing.length) {
      console.error(`${directory}: undocumented environment variables: ${missing.join(", ")}`);
    }
    if (stale.length) {
      console.error(`${directory}: documented but unused environment variables: ${stale.join(", ")}`);
    }
    if (invalidRequirements.length) {
      console.error(`${directory}: invalid requirement labels: ${invalidRequirements.join(", ")}`);
    }
    if (wrongDefaults.length) {
      console.error(`${directory}: documented defaults differ from code: ${wrongDefaults.join(", ")}`);
    }
    if (missingCommands.length) {
      console.error(`${directory}: undocumented commands: ${missingCommands.join(", ")}`);
    }
    if (staleCommands.length) {
      console.error(`${directory}: documented but unimplemented commands: ${staleCommands.join(", ")}`);
    }
  } else {
    console.log(`${directory}: ${implemented.size} environment variables and `
      + `${implementedCommands.size} commands documented exactly`);
  }
}

const shellDirectory = path.join(root, "web", "public", "docs", "coding-agents");
const shellFiles = fs.readdirSync(shellDirectory)
  .filter(file => file.endsWith(".html") && file !== "index.html");
const shellKeys = new Map(shellFiles.map(file => {
  const html = fs.readFileSync(path.join(shellDirectory, file), "utf8");
  const match = html.match(/<body\s+data-agent=(["'])([^"']+)\1/);
  return [path.basename(file, ".html"), match?.[2]];
}));
for (const guideKey of Object.keys(guides)) {
  if (shellKeys.get(guideKey) !== guideKey) {
    failed = true;
    console.error(`${guideKey}: missing shell or mismatched data-agent`);
  }
}
for (const [fileKey, agentKey] of shellKeys) {
  if (!agentKey || !(agentKey in guides) || fileKey !== agentKey) {
    failed = true;
    console.error(`${fileKey}.html: unknown or mismatched guide key ${JSON.stringify(agentKey)}`);
  }
}

if (failed) process.exit(1);
