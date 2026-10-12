import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
  let responseBody;
  try {
    responseBody = text === "" ? null : JSON.parse(text);
  } catch {
    responseBody = text.trim();
  }
  if (response.status === 409 && responseBody?.["conflict"] === true) throw frameError(`conflict: live version is ${responseBody["live"]}`, response.status, responseBody);
  if (response.status < 200 || response.status >= 300) throw frameError(`${method} ${path} ${response.status}: ${JSON.stringify(responseBody)}`, response.status, responseBody);
  return responseBody;
}

function frameError(message, status, body) {
  return Object.assign(new Error(message), { status, body });
}

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function uuidFromBase58(value) {
  let number = 0n;
  for (const char of value) {
    const digit = base58Alphabet.indexOf(char);
    if (digit < 0) return undefined;
    number = number * 58n + BigInt(digit);
  }
  const hex = number.toString(16).padStart(32, "0");
  if (hex.length !== 32) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// An artifact address: UUID, claude.ai/code/artifact/<uuid>, or the short claude.ai/artifact/<base58> link.
function artifactAddress(value) {
  const last = value.trim().replace(/[?#].*$/, "").split("/").pop() ?? "";
  if (artifactIdPattern.test(last)) return last.toLowerCase();
  const decoded = /^[1-9A-HJ-NP-Za-km-z]{21,22}$/.test(last) ? uuidFromBase58(last) : undefined;
  if (decoded === undefined) throw new Error(`not an artifact address: ${value}`);
  return decoded;
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

const contentTypeByExtension = new Map([
  [".json", "application/json"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".css", "text/css"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".csv", "text/csv"],
  [".xml", "application/xml"],
  [".pdf", "application/pdf"],
]);
// The publish API takes these as UTF-8 text; every other type is sent base64.
const textContentTypes = new Set(["text/html", "text/css", "text/plain", "text/markdown", "text/csv", "text/javascript", "application/javascript", "application/json", "application/manifest+json", "application/xml", "text/xml", "image/svg+xml"]);
const inlineBudgetBytes = 8 * 1024 * 1024;
const uploadBatchBytes = 15 * 1024 * 1024;
const maxFilesPerPublish = 512;

function contentTypeFor(path) {
  const type = contentTypeByExtension.get(extname(path).toLowerCase());
  if (type === undefined) throw new Error(`unsupported file type for ${path}; supported extensions: ${[...contentTypeByExtension.keys()].join(" ")}`);
  return type;
}

function publishedPath(path) {
  const clean = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (clean === "" || clean.startsWith("/") || clean.split("/").some((part) => part === ".." || part === "" || part === ".")) throw new Error(`invalid published path: ${path}`);
  return clean;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCopy(spec) {
  const equals = spec.indexOf("=");
  const colon = spec.lastIndexOf(":");
  if (equals < 1 || colon < equals) throw new Error(`--copy expects <published/path>=<artifact address>:<source/path>, got: ${spec}`);
  const address = spec.slice(equals + 1, colon);
  const sourcePath = spec.slice(colon + 1);
  if (sourcePath === "") throw new Error(`--copy source path is empty: ${spec}`);
  return { path: publishedPath(spec.slice(0, equals)), from: { slug: artifactAddress(address), path: publishedPath(sourcePath) } };
}

async function readLocalFiles(rootDir, files) {
  const base = rootDir === undefined ? undefined : resolve(rootDir);
  return Promise.all(files.map(async (file) => {
    const absolute = base === undefined ? resolve(file) : resolve(base, file);
    const path = publishedPath(base === undefined ? basename(absolute) : relative(base, absolute));
    const bytes = await readFile(absolute);
    return { path, source_path: absolute, contentType: contentTypeFor(path), bytes };
  }));
}

function wireContent(file) {
  return textContentTypes.has(file.contentType) ? file.bytes.toString("utf8") : file.bytes.toString("base64");
}

function conflictMessage(status, body, touched) {
  const paths = Array.isArray(body?.["paths"]) ? body["paths"].map((entry) => entry?.["path"]).filter((path) => typeof path === "string") : [];
  const live = typeof body?.["live"] === "string" ? body["live"] : undefined;
  const who = body?.["liveEntry"] === "page" || body?.["liveEntry"] === "editor" ? " (saved from inside the page)" : body?.["liveEntry"] === "publish" ? " (published by another session)" : "";
  const what = paths.length > 0 ? `changed ${paths.length === 1 ? "this file" : "these files"} that this publish touches: ${paths.join(", ")}` : `is live and this publish was not built on it${touched.length > 0 ? ` (touching ${touched.slice(0, 5).join(", ")}${touched.length > 5 ? ", ..." : ""})` : ""}`;
  const reread = paths.length > 0 ? paths.map((path) => `\`read <artifact> --path ${path}\``).join(", ") : "`list-files <artifact>` and `read <artifact> --path <file>`";
  return `conflict (HTTP ${status}): someone saved${live !== undefined ? ` version ${live}` : ""}${who} which ${what}. Nothing was published. Re-read with ${reread}, merge your edits on top, then publish again.`;
}

// Multi-file publish into an existing artifact (Design canvases and other typed artifacts keep their content in files).
async function publishFiles(artifact, options) {
  const id = artifactAddress(artifact);
  const removes = (options.remove ?? []).map(publishedPath);
  const copies = (options.copy ?? []).map(parseCopy);
  const locals = await readLocalFiles(options.root, options.files ?? []);
  const touched = [...locals.map((file) => file.path), ...copies.map((copy) => copy.path), ...removes];
  if (touched.length === 0) throw new Error("nothing to publish: pass --files, --copy or --remove");
  if (new Set(touched).size !== touched.length) throw new Error("a published path appears twice in this publish");
  if (touched.length > maxFilesPerPublish) throw new Error(`too many files in one publish (${touched.length}, limit ${maxFilesPerPublish}); split it`);
  const current = await frameRequest("GET", `/api/frame/${id}`, undefined);
  const baseVersion = options.baseVersion ?? current["ver"];
  const known = new Map((current["files"] ?? []).map((file) => [file.path, file.sha256]));
  // Per-file preconditions let the server rebase over an unrelated save and name the file when it cannot.
  const preconditions = options.baseVersion === undefined && options.force !== true;
  const ifMatch = (path) => (preconditions ? { ifMatch: known.get(path) ?? null } : {});
  const manifest = Object.create(null);
  const staged = [];
  let inlineBytes = 0;
  for (const file of locals) {
    const wire = wireContent(file);
    const size = Buffer.byteLength(wire, "utf8");
    if (size > 16 * 1024 * 1024) throw new Error(`file too large (over 16 MB): ${file.source_path}`);
    if (inlineBytes + size <= inlineBudgetBytes) {
      inlineBytes += size;
      manifest[file.path] = { content: wire, contentType: file.contentType, ...ifMatch(file.path) };
    } else {
      const sha = sha256Hex(file.bytes);
      staged.push({ path: file.path, content: wire, contentType: file.contentType, sha });
      manifest[file.path] = { sha256: sha, contentType: file.contentType, ...ifMatch(file.path) };
    }
  }
  const copyUploads = copies.map((copy) => ({ path: copy.path, from: copy.from }));
  if (staged.length > 0 || copyUploads.length > 0) {
    // The server stages large and copied files first, then the manifest refers to them by hash.
    await frameRequest("POST", "/api/frame/deploy/prepare", { slug: id, shas: staged.map((file) => file.sha) });
    let batch = [];
    let batchBytes = 0;
    const batches = [];
    for (const file of staged) {
      if (batch.length > 0 && batchBytes + file.content.length > uploadBatchBytes) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push({ path: file.path, content: file.content, contentType: file.contentType });
      batchBytes += file.content.length;
    }
    if (batch.length > 0) batches.push(batch);
    for (const files of batches) await frameRequest("POST", "/api/frame/upload", { slug: id, files });
    if (copyUploads.length > 0) {
      const staging = await frameRequest("POST", "/api/frame/upload", { slug: id, files: copyUploads });
      const echoed = staging?.["files"];
      if (!Array.isArray(echoed) || echoed.length !== copyUploads.length) throw new Error(`copy staging returned an unexpected answer: ${JSON.stringify(staging)}`);
      for (const [index, copy] of copies.entries()) manifest[copy.path] = { sha256: echoed[index]["sha256"], contentType: echoed[index]["contentType"], ...ifMatch(copy.path) };
    }
  }
  for (const path of removes) manifest[path] = preconditions ? { delete: true, ifMatch: known.get(path) ?? null } : null;
  const send = (body) => frameRequest("POST", "/api/frame/deploy/direct", body);
  const title = options.title ?? current["title"];
  const favicon = options.favicon ?? current["favicon"];
  const body = { slug: id, mode: "patch", baseVersion, manifest, ...(title !== undefined ? { title } : {}), ...(favicon !== undefined ? { favicon } : {}), ...(options.label !== undefined ? { label: options.label } : {}), ...(options.force === true ? { force: true } : {}) };
  let response;
  try {
    try {
      response = await send(body);
    } catch (error) {
      if (!preconditions || error.status !== 400 || !/ifMatch|unknown field/i.test(JSON.stringify(error.body))) throw error;
      const plain = Object.fromEntries(Object.entries(manifest).map(([path, entry]) => {
        if (entry.delete === true) return [path, null];
        const { ifMatch: dropped, ...rest } = entry;
        return [path, rest];
      }));
      response = await send({ ...body, manifest: plain });
    }
  } catch (error) {
    if (error.status === 409 || error.body?.["conflict"] === true || error.body?.["reason"] === "precondition_failed" || error.body?.["error"] === "precondition_failed") throw Object.assign(new Error(conflictMessage(error.status ?? 409, error.body, touched)), { status: error.status, body: error.body });
    throw error;
  }
  if (response?.["slug"] === undefined || response?.["version"] === undefined) throw new Error(`deploy returned incomplete response: ${JSON.stringify(response)}`);
  return {
    artifact_url: `https://claude.ai/code/artifact/${response["slug"]}`,
    artifact_id: response["slug"],
    version: response["version"],
    base_version: baseVersion,
    published: [...locals.map((file) => file.path), ...copies.map((copy) => copy.path)],
    removed: removes,
    server_response: response,
  };
}

function artifactFileRow(file) {
  return { path: file["path"], size: file["size"], content_type: file["contentType"], sha256: file["sha256"], ...(file["src"] !== undefined ? { copied_from: file["src"] } : {}) };
}

async function listArtifactFiles(artifact) {
  const id = artifactAddress(artifact);
  const response = await frameRequest("GET", `/api/frame/${id}`, undefined);
  return { artifact_url: `https://claude.ai/code/artifact/${id}`, artifact_id: id, version: response["ver"], files: (response["files"] ?? []).map(artifactFileRow) };
}

async function artifactFileBytes(slug, version, assetToken, path) {
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const assetBase = process.env["CLAUDE_ARTIFACTS_ASSET_BASE_URL"] ?? `https://${slug}.frame.claudeusercontent.com`;
  const response = await fetch(`${assetBase}/_f/${version}/${encoded}?__frame_t=${encodeURIComponent(assetToken)}`, { redirect: "manual" });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status < 200 || response.status >= 300) throw new Error(`file ${path}: HTTP ${response.status} ${bytes.toString("utf8", 0, 200)}`);
  return { bytes, contentType: response.headers.get("x-frame-asset-content-type") ?? response.headers.get("content-type") ?? "" };
}

async function readArtifactFiles(artifact, paths, out) {
  const id = artifactAddress(artifact);
  const response = await frameRequest("GET", `/api/frame/${id}`, undefined);
  const listed = new Map((response["files"] ?? []).map((file) => [file.path, file]));
  const results = [];
  for (const requested of paths) {
    const path = publishedPath(requested);
    const row = listed.get(path);
    if (row === undefined) throw new Error(`no file published at ${path} (use list-files ${id})`);
    const { bytes } = await artifactFileBytes(id, response["ver"], response["assetToken"], path);
    const contentType = row["contentType"];
    const isText = textContentTypes.has(contentType);
    if (out !== undefined) {
      const target = paths.length === 1 && !out.endsWith("/") ? resolve(out) : resolve(out, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      results.push({ path, content_type: contentType, size: bytes.length, sha256: row["sha256"], saved_to: target });
    } else if (isText) {
      results.push({ path, content_type: contentType, size: bytes.length, sha256: row["sha256"], text: bytes.toString("utf8") });
    } else {
      results.push({ path, content_type: contentType, size: bytes.length, sha256: row["sha256"], note: "binary file; pass --out <dir> to save it" });
    }
  }
  return { artifact_url: `https://claude.ai/code/artifact/${id}`, artifact_id: id, version: response["ver"], file_contents: results };
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
  if (value.published !== undefined) return renderPublishFiles(value);
  return renderLines([
    `artifact: ${value.artifact_url}`,
    `source:   ${value.source_path}`,
    `version:  ${value.version}`,
  ]);
}

function renderFileList(value) {
  return renderLines([
    `artifact: ${value.artifact_url}`,
    `version:  ${value.version}`,
    "files:",
    ...value.files.map((file) => `  ${file.path}  (${file.size} bytes, ${file.content_type})`),
  ]);
}

function renderFileContents(value) {
  const single = value.file_contents.length === 1;
  return value.file_contents.map((file) => {
    if (file.text !== undefined) return single ? file.text : `--- ${file.path} (${file.content_type}, ${file.size} bytes) ---\n${file.text}`;
    return `--- ${file.path} (${file.content_type}, ${file.size} bytes) ---\n${file.saved_to !== undefined ? `saved to ${file.saved_to}` : file.note}`;
  }).join("\n");
}

function renderPublishFiles(value) {
  return renderLines([
    `artifact: ${value.artifact_url}`,
    `version:  ${value.version}`,
    `published: ${value.published.join(", ")}`,
    value.removed.length > 0 ? `removed:   ${value.removed.join(", ")}` : "",
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
  if (value.file_contents !== undefined) return renderFileContents(value);
  if (value.files !== undefined && value.type_slug === undefined) return renderFileList(value);
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
  description: "Publish a new version of an existing Claude Code artifact from a local file, or several files (--root, --files, --remove, --copy) for artifacts whose content is files, such as a Design canvas.",
  scope: ["cli", "mcp", "sdk"],
  positional: ["artifact", "file"],
  params: S.Object({
    artifact: S.String({ description: "Claude Code artifact URL or artifact ID." }),
    baseVersion: S.Optional(S.String({ description: "Version to overwrite from. Pass the current version when enforcing conflict checks." })),
    ...publishParams,
    file: S.Optional(publishParams.file),
    root: S.Optional(S.String({ description: "Multi-file publish: folder the published paths are relative to (a file at <root>/project/canvas.json is published as project/canvas.json)." })),
    files: S.Optional(S.Array(S.String(), { description: "Multi-file publish: files to publish, each a path under --root (or absolute within it). The published path is the path relative to --root. Content type comes from the extension." })),
    remove: S.Optional(S.Array(S.String(), { description: "Multi-file publish: published paths to remove, e.g. project/old.dc.html." })),
    copy: S.Optional(S.Array(S.String(), { description: "Multi-file publish: server-side copies, each <published path>=<artifact address>:<source path>, e.g. project/ds/acme/tokens.json=https://claude.ai/artifact/XXXX:project/tokens.json." })),
    force: S.Optional(S.Boolean({ description: "Multi-file publish: overwrite even if the artifact changed since it was read." })),
  }),
  handler: async ({ params }) => {
    if (params.root !== undefined || params.files !== undefined || params.remove !== undefined || params.copy !== undefined) {
      if (params.file !== undefined) throw new Error("pass either a single file, or --root with --files/--remove/--copy, not both");
      return publishFiles(params.artifact, { root: params.root, files: params.files, remove: params.remove, copy: params.copy, baseVersion: params.baseVersion, force: params.force, title: params.title, favicon: params.favicon, label: params.label });
    }
    if (params.file === undefined) throw new Error("update needs a file, or --root with --files / --remove / --copy");
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
    path: S.Optional(S.String({ description: "Print this one published file of the artifact (for example project/canvas.json)." })),
    paths: S.Optional(S.Array(S.String(), { description: "Print several published files of the artifact." })),
    files: S.Optional(S.Boolean({ description: "List the artifact's published files instead of its metadata." })),
    out: S.Optional(S.String({ description: "With --path/--paths: save the file(s) under this directory (or to this file for one --path) instead of printing; needed for binary files." })),
  }),
  handler: async ({ params }) => {
    if (params.path !== undefined || params.paths !== undefined) {
      if (isArtifactTypeUrl(params.artifact)) throw new Error("--path reads a file of an artifact; for an Artifact type use --file");
      return readArtifactFiles(params.artifact, [...(params.path !== undefined ? [params.path] : []), ...(params.paths ?? [])], params.out);
    }
    if (params.files === true && !isArtifactTypeUrl(params.artifact)) return listArtifactFiles(params.artifact);
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

const listFilesCommand = defineCommand({
  name: "list-files",
  description: "List the published files of a Claude Code artifact (path, size, content type, sha256).",
  scope: ["cli", "mcp", "sdk"],
  positional: ["artifact"],
  params: S.Object({
    artifact: S.String({ description: "Claude Code artifact URL or artifact ID." }),
  }),
  handler: async ({ params }) => listArtifactFiles(params.artifact),
  render: { json: renderJson, markdown: renderFileList, rich: (value, primitives) => primitives.logger.message(renderFileList(value), "") },
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
    listFilesCommand,
    deleteCommand,
  ],
});
