import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { defineCommand, defineGroup, S } from "toolcraft";
import { parse } from "toolcraft/design/parse";
import { renderHtml } from "toolcraft/design/render-html";
import { renderMarkdownHtml } from "toolcraft/design/render-markdown-html";

const artifactIdPattern = /^[0-9a-fA-F-]{36}$/;
const execFilePromise = promisify(execFile);
const artifactCss = await readFile(new URL("./artifact.css", import.meta.url), "utf8");
const artifactsGalleryUrl = "https://claude.ai/code/artifacts";
const markdownHtmlOptions = { syntaxHighlight: true };
const codeLanguageByExtension = new Map([
  [".cjs", "js"],
  [".css", "css"],
  [".csv", "csv"],
  [".env", "sh"],
  [".js", "js"],
  [".json", "json"],
  [".jsonc", "jsonc"],
  [".jsx", "jsx"],
  [".log", "text"],
  [".mjs", "js"],
  [".py", "python"],
  [".rb", "ruby"],
  [".sh", "sh"],
  [".sql", "sql"],
  [".toml", "toml"],
  [".ts", "ts"],
  [".tsx", "tsx"],
  [".txt", "text"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);

function artifactId(value) {
  if (artifactIdPattern.test(value)) return value;
  const url = new URL(value);
  const parts = url.pathname.split("/");
  return parts[parts.length - 1];
}

function requireArtifactId(value) {
  const id = artifactId(value);
  if (!artifactIdPattern.test(id)) throw new Error(`not an artifact id: ${value} (an Artifact type url cannot be updated or deleted)`);
  return id;
}

function sourceKind(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  return "code";
}

function sourceLanguage(path) {
  const extension = extname(path).toLowerCase();
  if (extension === "") return "text";
  return codeLanguageByExtension.get(extension) ?? (extension.slice(1).replace(/[^a-z0-9_+-]/gi, "") || "text");
}

async function validateArtifactSource(file) {
  const path = resolve(file);
  const fileStat = await stat(path);
  const kind = sourceKind(path);
  const language = kind === "code" ? sourceLanguage(path) : undefined;
  return {
    path,
    kind,
    language,
    bytes: fileStat.size,
    under_size_limit: fileStat.size <= 16 * 1024 * 1024,
    publishable: fileStat.size <= 16 * 1024 * 1024,
  };
}

function pageHtml(bodyHtml) {
  return `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><style>${artifactCss}</style></head><body>\n${bodyHtml}\n</body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderFrontmatterValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    return `<table><tbody><tr>${value.map((item) => `<td>${renderFrontmatterValue(item)}</td>`).join("")}</tr></tbody></table>`;
  }
  if (value !== null && typeof value === "object") return renderNestedFrontmatterTable(value);
  if (value === null || value === undefined) return "";
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function renderNestedFrontmatterTable(frontmatter) {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return "";
  const headers = entries.map(([key]) => `<th>${escapeHtml(key)}</th>`).join("");
  const values = entries.map(([, value]) => `<td>${renderFrontmatterValue(value)}</td>`).join("");
  return `<table><thead><tr>${headers}</tr></thead><tbody><tr>${values}</tr></tbody></table>`;
}

function renderFrontmatterTable(frontmatter) {
  if (frontmatter === undefined) return "";
  const rows = Object.entries(frontmatter)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${renderFrontmatterValue(value)}</td></tr>`)
    .join("");
  return rows === "" ? "" : `<table class="frontmatter"><tbody>${rows}</tbody></table>`;
}

function renderArtifactMarkdownHtml(source) {
  const { ast, frontmatter } = parse(source);
  return [renderFrontmatterTable(frontmatter), renderHtml(ast, markdownHtmlOptions)].filter(Boolean).join("\n");
}

function fencedMarkdown(source, language) {
  const longestBacktickRun = Math.max(2, ...[...source.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence}${language}\n${source.replace(/\s*$/, "\n")}${fence}`;
}

async function artifactContent(path, kind, language) {
  const source = await readFile(path, "utf8");
  if (kind === "markdown") {
    return pageHtml(renderArtifactMarkdownHtml(source));
  }
  if (/<!doctype\s+html/i.test(source) || /<html[\s>]/i.test(source)) return source;
  if (kind === "html") return pageHtml(source);
  return pageHtml(renderMarkdownHtml(fencedMarkdown(source, language ?? "text"), markdownHtmlOptions));
}

async function artifactTitle(path, title) {
  if (title !== undefined) return title;
  return basename(path, extname(path));
}

async function oauthToken() {
  if (process.env["CLAUDE_CODE_OAUTH_TOKEN"]) return process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (process.platform === "darwin") {
    const result = await execFilePromise("security", ["find-generic-password", "-a", process.env["USER"], "-w", "-s", "Claude Code-credentials"], { encoding: "utf8" });
    return JSON.parse(result.stdout)["claudeAiOauth"]["accessToken"];
  }
  const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  return JSON.parse(await readFile(join(configDir, ".credentials.json"), "utf8"))["claudeAiOauth"]["accessToken"];
}

function artifactsApiBaseUrl() {
  if (process.env["CLAUDE_CODE_ARTIFACTS_API_BASE_URL"] !== undefined) return process.env["CLAUDE_CODE_ARTIFACTS_API_BASE_URL"].replace(/\/+$/, "");
  return "https://api.anthropic.com";
}

async function frameRequest(method, path, body) {
  const response = await fetch(`${artifactsApiBaseUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await oauthToken()}`,
      "content-type": "application/json",
      "X-Frame-CP": "go",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const responseBody = text === "" ? null : JSON.parse(text);
  if (response.status === 409 && responseBody?.["conflict"] === true) throw new Error(`conflict: live version is ${responseBody["live"]}`);
  if (response.status < 200 || response.status >= 300) throw new Error(`${method} ${path} ${response.status}: ${JSON.stringify(responseBody)}`);
  return responseBody;
}

const typeSlugPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const typeInstructionsFile = "SKILL.md";

function isArtifactTypeUrl(value) {
  try {
    const url = new URL(value);
    return /^\/artifact\/[A-Za-z0-9]+$/.test(url.pathname) && url.hostname.endsWith("claude.ai");
  } catch {
    return false;
  }
}

function typeSummary(type) {
  return {
    type_url: type["url"],
    type_slug: type["slug"],
    name: type["title"],
    description: type["description"],
    favicon: type["favicon"],
    scope: type["listings"]?.map((listing) => listing["scope"]).filter(Boolean).join(", "),
    tier: type["listings"]?.map((listing) => listing["tier"]).filter(Boolean).join(", "),
    release: type["release"]?.["version"],
  };
}

async function listTypes(query) {
  const response = await frameRequest("GET", query === undefined || query === "" ? "/api/frame/types" : `/api/frame/types?q=${encodeURIComponent(query)}`, undefined);
  return { types: (response["types"] ?? []).map(typeSummary), next_page_token: response["next_page_token"] };
}

// A type is addressed by its claude.ai/artifact/<short id> url, its slug (UUID), or its name.
async function resolveType(reference) {
  if (typeSlugPattern.test(reference)) return reference.toLowerCase();
  const { types } = await listTypes(undefined);
  const wanted = reference.trim();
  const wantedId = isArtifactTypeUrl(wanted) ? wanted.split("/").pop() : undefined;
  const byUrl = types.find((type) => wantedId !== undefined && type.type_url.split("/").pop() === wantedId);
  if (byUrl !== undefined) return byUrl.type_slug;
  const exact = types.filter((type) => type.name.toLowerCase() === wanted.toLowerCase());
  if (exact.length === 1) return exact[0].type_slug;
  const partial = exact.length > 1 ? exact : types.filter((type) => type.name.toLowerCase().includes(wanted.toLowerCase()));
  if (partial.length === 1) return partial[0].type_slug;
  const known = types.map((type) => `${type.name} (${type.type_url})`).join(", ");
  throw new Error(`${partial.length > 1 ? "ambiguous" : "unknown"} artifact type "${reference}"; available: ${known}`);
}

async function typeFile(slug, path) {
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  return frameRequest("GET", `/api/frame/types/${slug}/files/${encoded}`, undefined);
}

async function readType(reference, file) {
  const slug = await resolveType(reference);
  if (file !== undefined) {
    const body = await typeFile(slug, file);
    return { type_slug: slug, path: body["path"], content_type: body["content_type"], size_bytes: body["size_bytes"], release: body["release"]?.["version"], truncated: body["truncated"], text: body["text"] };
  }
  const body = await frameRequest("GET", `/api/frame/types/${slug}`, undefined);
  return { ...typeSummary(body), files: body["files"] };
}

async function createFromType(reference, title) {
  const slug = await resolveType(reference);
  const response = await frameRequest("POST", `/api/frame/types/${slug}/create`, { target_type_version: null, ...(title !== undefined && title !== "" ? { title } : {}) });
  const id = response["slug"];
  if (id === undefined) throw new Error(`create from type returned incomplete response: ${JSON.stringify(response)}`);
  let instructions;
  let instructionsError;
  try {
    instructions = (await typeFile(slug, typeInstructionsFile))["text"];
  } catch (error) {
    instructionsError = error instanceof Error ? error.message : String(error);
  }
  const url = `https://claude.ai/code/artifact/${id}`;
  return {
    artifact_url: url,
    artifact_id: id,
    title: response["title"],
    version: response["version"],
    type_slug: slug,
    server_response: response,
    instructions_file: typeInstructionsFile,
    ...(instructions !== undefined ? { instructions } : {}),
    ...(instructionsError !== undefined ? { instructions_error: instructionsError } : {}),
    next: `${url} now exists but is empty. Fill it as the type's instructions (${typeInstructionsFile}, below) describe, then open the url. Do not create again for this artifact.`,
  };
}

async function listArtifactsOfType(reference) {
  const slug = await resolveType(reference);
  const response = await frameRequest("GET", `/api/frame/types/${slug}/instances?limit=200`, undefined);
  return {
    type_slug: slug,
    artifacts: (response["instances"] ?? []).map((instance) => ({
      artifact_url: `https://claude.ai/code/artifact/${instance["slug"]}`,
      artifact_id: instance["slug"],
      title: instance["title"],
      relation: instance["rel"],
      created_at: instance["created_at"],
      updated_at: instance["published_at"],
      updated_at_display: instance["published_at"] !== undefined ? formatTimestamp(instance["published_at"]) : undefined,
      type_version: instance["current_type_version"],
    })),
    next_page_token: response["next_page_token"],
  };
}

async function artifactAssetContent(slug, version, assetToken) {
  const response = await fetch(`https://${slug}.frame.claudeusercontent.com/_f/${version}/?__frame_t=${encodeURIComponent(assetToken)}`, {
    redirect: "manual",
  });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) throw new Error(`asset ${response.status}: ${text.slice(0, 200)}`);
  return text.replace(`<base href="/_f/${version}/">`, "");
}

function artifactMetadata(slug, body) {
  return {
    artifact_url: `https://claude.ai/code/artifact/${slug}`,
    artifact_id: slug,
    title: body["title"],
    favicon: body["favicon"],
    version: body["ver"],
    live: body["live"],
    role: body["perm"]?.["role"],
    share_mode: body["perm"]?.["mode"],
    author_email: body["author"]?.["email"],
    created_at: body["created_at"],
    updated_at: body["updated_at"],
    history: body["history"],
    versions: body["versions"],
  };
}

async function publishDirect(path, kind, language, slug, title, favicon = "*", label, baseVersion) {
  const content = await artifactContent(path, kind, language);
  const body = {
    title: await artifactTitle(path, title),
    favicon,
    content,
    ...(slug !== undefined ? { slug } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  };
  const responseBody = await frameRequest("POST", "/api/frame/deploy/direct", body);
  const responseSlug = responseBody["slug"];
  const version = responseBody["version"];
  if (responseSlug === undefined || version === undefined) throw new Error(`deploy returned incomplete response: ${JSON.stringify(responseBody)}`);
  return {
    artifact_url: `https://claude.ai/code/artifact/${responseSlug}`,
    artifact_id: responseSlug,
    version,
    read: responseBody["read"],
    shared: responseBody["shared"],
  };
}

function renderJson(value) {
  return value;
}

function renderLines(lines) {
  return lines.filter((line) => line !== "").join("\n");
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function renderPublish(value) {
  return renderLines([
    `artifact: ${value.artifact_url}`,
    `source:   ${value.source_path}`,
    `version:  ${value.version}`,
  ]);
}

function renderRead(value) {
  return renderLines([
    `artifact: ${value.artifact_url}`,
    `title:    ${value.title}`,
    `version:  ${value.version}`,
    `role:     ${value.role}`,
    `updated:  ${value.updated_at}`,
    value.content_html !== undefined ? "" : "",
    value.content_html !== undefined ? "```html" : "",
    value.content_html !== undefined ? value.content_html : "",
    value.content_html !== undefined ? "```" : "",
  ]);
}

function renderList(value) {
  const galleryLine = `gallery: ${value.gallery_url}`;
  if (value.artifacts.length === 0) return renderLines([galleryLine, "no code artifacts"]);
  return renderLines([
    galleryLine,
    "",
    value.artifacts.map((artifact, index) => renderLines([
      `${index + 1}. ${artifact.title ?? "(untitled)"}`,
      `   id:      ${artifact.artifact_id}`,
      `   url:     ${artifact.artifact_url}`,
      `   updated: ${artifact.updated_at_display}`,
      artifact.label !== undefined ? `   label:   ${artifact.label}` : "",
      `   owner:   ${artifact.owner_email}`,
      `   access:  ${artifact.relation}`,
      `   views:   ${artifact.view_count} total, ${artifact.unique_view_count} unique`,
    ])).join("\n\n"),
  ]);
}

function renderTypes(value) {
  if (value.types.length === 0) return "no artifact types";
  return value.types.map((type, index) => renderLines([
    `${index + 1}. ${type.name}`,
    `   type_url:    ${type.type_url}`,
    `   scope:       ${type.scope ?? ""}${type.tier ? ` (${type.tier})` : ""}`,
    `   description: ${type.description ?? ""}`,
  ])).join("\n\n");
}

function renderTypeArtifacts(value) {
  if (value.artifacts.length === 0) return "no artifacts made from this type";
  return value.artifacts.map((artifact, index) => renderLines([
    `${index + 1}. ${artifact.title ?? "(untitled)"}`,
    `   id:      ${artifact.artifact_id}`,
    `   url:     ${artifact.artifact_url}`,
    `   updated: ${artifact.updated_at_display ?? ""}`,
    `   access:  ${artifact.relation}`,
  ])).join("\n\n");
}

function renderListAny(value) {
  if (value.types !== undefined) return renderTypes(value);
  if (value.type_slug !== undefined) return renderTypeArtifacts(value);
  return renderList(value);
}

function renderTypeRead(value) {
  if (value.text !== undefined) return value.text;
  return renderLines([
    `type:        ${value.name}`,
    `type_url:    ${value.type_url}`,
    `release:     ${value.release}`,
    `description: ${value.description}`,
    "files:",
    ...(value.files ?? []).map((file) => `  ${file.path}  (${file.size} bytes, ${file.content_type})`),
  ]);
}

function renderReadAny(value) {
  return value.type_slug !== undefined ? renderTypeRead(value) : renderRead(value);
}

function renderCreate(value) {
  if (value.instructions_file === undefined) return renderPublish(value);
  return renderLines([
    `artifact: ${value.artifact_url}`,
    `title:    ${value.title}`,
    `version:  ${value.version}`,
    "",
    value.next,
    "",
    value.instructions !== undefined ? `--- type instructions (${value.instructions_file}) ---` : `type instructions unavailable: ${value.instructions_error}`,
    value.instructions ?? "",
  ]);
}

function renderDelete(value) {
  return `deleted: ${value.artifact_url}`;
}

const publishParams = {
  file: S.String({ description: "Local HTML, Markdown, or text/code data file to publish." }),
  favicon: S.Optional(S.String({ description: "One or two emoji for the artifact browser-tab icon. Defaults to *." })),
  title: S.Optional(S.String({ description: "Artifact title. Defaults to the file basename." })),
  label: S.Optional(S.String({ description: "Version label shown in the artifact version picker." })),
};

const createCommand = defineCommand({
  name: "create",
  aliases: ["publish"],
  description: "Publish a new Claude Code artifact from a local file using the current Claude Code login without an LLM turn.",
  scope: ["cli", "mcp", "sdk"],
  positional: ["file"],
  params: S.Object({
    ...publishParams,
    file: S.Optional(publishParams.file),
    type: S.Optional(S.String({ description: "Create from an Artifact type instead of a file (Design, Slides, Dashboard, Docs, Design System): a type_url from `list --types`, or the type name. Give no file; the result carries the type's instructions for filling the new artifact." })),
  }),
  handler: async ({ params }) => {
    if (params.type !== undefined) {
      if (params.file !== undefined) throw new Error("--type creates an empty artifact from a type; do not pass a file (publish files afterwards as the type's instructions say)");
      return createFromType(params.type, params.title);
    }
    if (params.file === undefined) throw new Error("create needs a file, or --type <type_url|name> to start from an Artifact type");
    const validation = await validateArtifactSource(params.file);
    if (!validation.publishable) throw new Error(`Artifact source is not publishable: ${validation.path}`);
    const published = await publishDirect(validation.path, validation.kind, validation.language, undefined, params.title, params.favicon, params.label, undefined);
    return { ...published, source_path: validation.path };
  },
  render: { json: renderJson, markdown: renderCreate, rich: (value, primitives) => primitives.logger.message(renderCreate(value), "") },
});

const updateCommand = defineCommand({
  name: "update",
  description: "Publish a new version of an existing Claude Code artifact from a local file.",
  scope: ["cli", "mcp", "sdk"],
  positional: ["artifact", "file"],
  params: S.Object({
    artifact: S.String({ description: "Claude Code artifact URL or artifact ID." }),
    baseVersion: S.Optional(S.String({ description: "Version to overwrite from. Pass the current version when enforcing conflict checks." })),
    ...publishParams,
  }),
  handler: async ({ params }) => {
    const validation = await validateArtifactSource(params.file);
    if (!validation.publishable) throw new Error(`Artifact source is not publishable: ${validation.path}`);
    const published = await publishDirect(validation.path, validation.kind, validation.language, requireArtifactId(params.artifact), params.title, params.favicon, params.label, params.baseVersion);
    return { ...published, artifact_id: requireArtifactId(params.artifact), source_path: validation.path };
  },
  render: { json: renderJson, markdown: renderPublish, rich: (value, primitives) => primitives.logger.message(renderPublish(value), "") },
});

const readCommand = defineCommand({
  name: "read",
  description: "Read a Claude Code artifact from the Claude frame API, or an Artifact type (its url from `list --types`) to see its files.",
  scope: ["cli", "mcp", "sdk"],
  positional: ["artifact"],
  params: S.Object({
    artifact: S.String({ description: "Claude Code artifact URL or artifact ID." }),
    content: S.Optional(S.Boolean({ description: "Include current HTML content." })),
    contentVersion: S.Optional(S.String({ description: "Artifact version to fetch when content is included." })),
    file: S.Optional(S.String({ description: "With an Artifact type url or name: print this one file of the type (for example SKILL.md) instead of the file list." })),
  }),
  handler: async ({ params }) => {
    if (isArtifactTypeUrl(params.artifact) || (!artifactIdPattern.test(params.artifact) && !params.artifact.includes("/"))) return readType(params.artifact, params.file);
    const id = artifactId(params.artifact);
    const response = await frameRequest("GET", `/api/frame/${id}`, undefined);
    const metadata = artifactMetadata(id, response);
    if (params.content !== true) return metadata;
    const version = params.contentVersion ?? response["ver"];
    const content = await artifactAssetContent(id, version, response["assetToken"]);
    return { ...metadata, version, content_html: content, content_bytes: Buffer.byteLength(content, "utf8") };
  },
  render: { json: renderJson, markdown: renderReadAny, rich: (value, primitives) => primitives.logger.message(renderReadAny(value), "") },
});

const listCommand = defineCommand({
  name: "list",
  description: "List Claude Code artifacts from the Claude frame API.",
  scope: ["cli", "mcp", "sdk"],
  params: S.Object({
    limit: S.Optional(S.Number({ description: "Maximum number of artifacts to request." })),
    types: S.Optional(S.Boolean({ description: "List the Artifact types (Design, Slides, Dashboard, Docs, Design System, ...) you can create artifacts from, instead of artifacts." })),
    query: S.Optional(S.String({ description: "With --types: filter the type catalog by this text." })),
    type: S.Optional(S.String({ description: "List the artifacts made from this Artifact type (a type_url or the type name), for example your design systems." })),
  }),
  handler: async ({ params }) => {
    if (params.types === true) return listTypes(params.query);
    if (params.type !== undefined) return listArtifactsOfType(params.type);
    const response = await frameRequest("GET", `/api/frame/frames?limit=${params.limit ?? 60}`, undefined);
    const artifacts = response["frames"]
      .filter((frame) => frame["source_surface"] === "code")
      .map((frame) => ({
        artifact_url: `https://claude.ai/code/artifact/${frame["slug"]}`,
        artifact_id: frame["slug"],
        title: frame["title"],
        label: frame["label"],
        owner_email: frame["owner_email"],
        owner_account: frame["owner_account"],
        relation: frame["rel"],
        source_surface: frame["source_surface"],
        view_count: frame["view_count"],
        unique_view_count: frame["unique_view_count"],
        updated_at: frame["updatedAt"],
        updated_at_display: formatTimestamp(frame["updatedAt"]),
      }));
    return { gallery_url: artifactsGalleryUrl, artifacts };
  },
  render: { json: renderJson, markdown: renderListAny, rich: (value) => process.stdout.write(`${renderListAny(value)}\n`) },
});

const deleteCommand = defineCommand({
  name: "delete",
  description: "Delete a Claude Code artifact.",
  scope: ["cli", "mcp", "sdk"],
  positional: ["artifact"],
  params: S.Object({
    artifact: S.String({ description: "Claude Code artifact URL or artifact ID." }),
  }),
  handler: async ({ params }) => {
    const id = requireArtifactId(params.artifact);
    await frameRequest("DELETE", `/api/frame/${id}`, undefined);
    return { deleted: true, artifact_id: id, artifact_url: `https://claude.ai/code/artifact/${id}` };
  },
  render: { json: renderJson, markdown: renderDelete, rich: (value, primitives) => primitives.logger.message(renderDelete(value), "") },
});

export const root = defineGroup({
  name: "claude-artifacts",
  description: "Create Claude Code artifacts with the current Claude Code login.",
  scope: ["cli", "mcp", "sdk"],
  children: [
    createCommand,
    readCommand,
    updateCommand,
    listCommand,
    deleteCommand,
  ],
});
