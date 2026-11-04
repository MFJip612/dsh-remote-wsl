/**
 * Pure path helpers for mapping between WSL Linux paths, Windows drive paths and WSL UNC paths.
 *
 * No DSH/ctx imports and no I/O: every function is deterministic. The only Node API used is
 * `node:path`'s posix variant (`joinLinux`). Utility functions that take a path never throw except
 * `normalizeLinuxPath`, which is the single validation gate (it throws an error carrying
 * `code: "invalid-path"`); the helpers built on it fall back to the root path instead.
 *
 * UNC conversion is ported from ZCode `packages/server/src/remote/wsl-backend.ts:111-116` and
 * `packages/desktop/src/main/openInEditor.ts:89-98`.
 */

import { posix } from "node:path";

/** Default root under which WSL auto-mounts Windows drives (`[automount] root` in /etc/wsl.conf). */
export const DEFAULT_MOUNT_ROOT = "/mnt";

const MAX_DISTRO_NAME_LENGTH = 64;
const MAX_WSL_USER_LENGTH = 64;

/** Control characters (C0 plus DEL) are never valid inside a path, name or user. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
/** Characters Windows/WSL refuse in a distro name (same set as Windows file names). */
const DISTRO_NAME_FORBIDDEN_PATTERN = /[/\\:*?"<>|]/;

function invalidPathError(reason) {
  return Object.assign(new Error(`invalid Linux path: ${reason}`), { code: "invalid-path" });
}

/**
 * Shared normalization core. Returns `null` for invalid input instead of throwing so that the
 * non-validating helpers stay total and can fall back to `/`.
 *
 * Rules: `\` -> `/`, collapse repeated `/`, resolve `.` / `..` lexically, always absolute,
 * strip the trailing `/` (except for the root itself).
 *
 * @param {unknown} input
 * @returns {string|null}
 */
function normalizeLinuxPathOrNull(input) {
  if (typeof input !== "string" || input.length === 0) {
    return null;
  }
  if (CONTROL_CHARACTER_PATTERN.test(input)) {
    return null;
  }

  const unified = input.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  /** @type {string[]} */
  const segments = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      // `..` above the root stays at the root, matching POSIX resolver behaviour.
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `/${segments.join("/")}`;
}

/**
 * Normalize a user-supplied Linux path into an absolute, lexically-resolved posix path.
 *
 * @param {string} input
 * @returns {string} e.g. `/a/../b` -> `/b`, `''` -> throws
 * @throws {Error & {code: "invalid-path"}} for empty, non-string or control-character input
 */
export function normalizeLinuxPath(input) {
  if (typeof input === "string" && input.length === 0) {
    throw invalidPathError("empty");
  }

  const normalized = normalizeLinuxPathOrNull(input);
  if (normalized === null) {
    throw invalidPathError(
      typeof input === "string" ? "contains control characters" : "not a string",
    );
  }
  return normalized;
}

/**
 * Join a Linux base directory with a relative path (posix semantics; no `~` handling).
 *
 * @param {string} base
 * @param {string} relative
 * @returns {string}
 */
export function joinLinux(base, relative) {
  return posix.join(base, relative);
}

/**
 * Expand a leading `~` / `~/` against a resolved home directory.
 * The `~user` form is intentionally not supported (kept unchanged).
 *
 * @param {string} linuxPath
 * @param {string} home absolute home directory, e.g. `/home/mingfai`
 * @returns {string}
 */
export function expandTilde(linuxPath, home) {
  if (typeof linuxPath !== "string" || typeof home !== "string") {
    return linuxPath;
  }
  if (linuxPath === "~") {
    return home;
  }
  if (linuxPath.startsWith("~/")) {
    // Preserve the literal `home + "/tail"` shape (ported from wsl-backend.ts:628-641).
    return home.endsWith("/") ? `${home}${linuxPath.slice(2)}` : `${home}${linuxPath.slice(1)}`;
  }
  return linuxPath;
}

/**
 * @param {string} path
 * @returns {boolean} true when the path is rooted (`/...`)
 */
export function isAbsoluteLinuxPath(path) {
  return typeof path === "string" && path.startsWith("/");
}

/**
 * Validate a WSL distribution name before handing it to `wsl.exe`.
 *
 * Rules: non-empty string, at most 64 characters, no control characters, none of `/ \ : * ? " < > |`,
 * and no leading/trailing whitespace (a name that needs trimming is treated as invalid because the
 * caller must pass back exactly what was validated).
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isValidDistroName(name) {
  if (typeof name !== "string") {
    return false;
  }
  if (name.length === 0 || name.length > MAX_DISTRO_NAME_LENGTH) {
    return false;
  }
  if (name !== name.trim()) {
    return false;
  }
  if (CONTROL_CHARACTER_PATTERN.test(name)) {
    return false;
  }
  return !DISTRO_NAME_FORBIDDEN_PATTERN.test(name);
}

/**
 * Validate a WSL user name. Ported from ZCode `packages/shared/src/wslUserValidation.ts:5-15`:
 * the value is trimmed first, then must be non-empty, at most 64 characters and free of control
 * characters and path/account separators.
 *
 * Empty input is *invalid* here; the caller treats "empty" as "use the distro's default user".
 *
 * @param {string} user
 * @returns {boolean}
 */
export function isValidWslUser(user) {
  if (typeof user !== "string") {
    return false;
  }
  const value = user.trim();
  return (
    value.length > 0 &&
    value.length <= MAX_WSL_USER_LENGTH &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    !value.includes(":") &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

/** `\\wsl.localhost\<distro>\<tail...>` / `\\wsl$\<distro>\<tail...>` (prefix case-insensitive). */
const WSL_HOST_PATH_PATTERN = /^\\\\(wsl\.localhost|wsl\$)\\([^\\/]+)(?:\\([\s\S]*))?$/i;

/**
 * Parse a WSL UNC host path back into `{ distro, linuxPath }`.
 * Returns `undefined` for anything that is not a WSL UNC path (including plain drive paths).
 *
 * @param {string} hostPath e.g. `\\wsl.localhost\Ubuntu\home\mingfai`
 * @returns {{distro: string, linuxPath: string}|undefined}
 */
export function parseWslHostPath(hostPath) {
  if (typeof hostPath !== "string" || hostPath.length === 0) {
    return undefined;
  }

  // Accept mixed separators (`//wsl.localhost/Ubuntu/home`) by normalizing to backslashes first.
  const normalized = hostPath.replaceAll("/", "\\");
  const match = WSL_HOST_PATH_PATTERN.exec(normalized);
  if (!match) {
    return undefined;
  }

  const distro = match[2];
  const tail = match[3] ?? "";
  const segments = tail.split("\\").filter(Boolean);
  return {
    distro,
    linuxPath: segments.length === 0 ? "/" : `/${segments.join("/")}`,
  };
}

/**
 * Build the two UNC path spellings Windows accepts for a WSL path, in fallback order.
 * Ported from wsl-backend.ts:111-116 (try `wsl.localhost` first, then the legacy `wsl$`).
 *
 * @param {string} linuxPath
 * @param {string} distro
 * @returns {[string, string]} `['\\\\wsl.localhost\\<distro>\\<seg>', '\\\\wsl$\\<distro>\\<seg>']`
 */
export function uncCandidates(linuxPath, distro) {
  const segments = String(linuxPath ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
  const suffix = segments.length > 0 ? `\\${segments.join("\\")}` : "";
  return [`\\\\wsl.localhost\\${distro}${suffix}`, `\\\\wsl$\\${distro}${suffix}`];
}

/**
 * Normalize the mount root option into an absolute posix path without a trailing slash.
 *
 * @param {unknown} mountRoot
 * @returns {string}
 */
function normalizeMountRoot(mountRoot) {
  if (typeof mountRoot !== "string" || mountRoot.length === 0) {
    return DEFAULT_MOUNT_ROOT;
  }
  const unified = mountRoot.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  const trimmed = unified.replace(/\/+$/, "");
  if (trimmed === "") {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Map an already-normalized Linux path below the mount root to a Windows drive path.
 *
 * @param {string} linuxPath normalized absolute Linux path
 * @param {string} mountRoot normalized mount root
 * @returns {string|null} e.g. `/mnt/e/source` -> `E:\source`, `/mnt/e` -> `E:\`; `null` when not mounted
 */
function linuxPathToDrivePath(linuxPath, mountRoot) {
  const prefix = mountRoot === "/" ? "" : mountRoot;
  if (prefix !== "" && linuxPath !== prefix && !linuxPath.startsWith(`${prefix}/`)) {
    return null;
  }

  const rest = prefix === "" ? linuxPath : linuxPath.slice(prefix.length);
  const segments = rest.split("/").filter(Boolean);
  // The first segment after the mount root must be a single drive letter; anything else (e.g.
  // `/mnt/wslg`) is a WSL-managed mount and stays on the UNC path.
  if (segments.length === 0 || !/^[A-Za-z]$/.test(segments[0])) {
    return null;
  }

  const drive = `${segments[0].toUpperCase()}:`;
  const tail = segments.slice(1);
  return tail.length === 0 ? `${drive}\\` : `${drive}\\${tail.join("\\")}`;
}

/**
 * Convert a Linux path into the best Windows-side path.
 *
 * - `/mnt/e/source` with the default mount root maps to `E:\source` (`mapped: "windows"`).
 * - `/mnt/e` maps to the drive root `E:\`.
 * - Every other path (including `/mnt` itself and custom mounts) falls back to
 *   `\\<uncHost>\<distro>\<seg...>`; the Linux root maps to `\\<uncHost>\<distro>`.
 *
 * @param {string} linuxPath
 * @param {string} distro
 * @param {{mountRoot?: string, uncHost?: string}} [options]
 * @returns {{linuxPath: string, hostPath: string, mapped: "windows"|"unc"}}
 * @throws {Error & {code: "invalid-path"}} when `linuxPath` is invalid
 */
export function linuxToHostPath(linuxPath, distro, options = {}) {
  const normalized = normalizeLinuxPath(linuxPath);
  const mountRoot = normalizeMountRoot(options?.mountRoot);
  const uncHost =
    typeof options?.uncHost === "string" && options.uncHost.length > 0
      ? options.uncHost
      : "wsl.localhost";

  const drivePath = linuxPathToDrivePath(normalized, mountRoot);
  if (drivePath !== null) {
    return { linuxPath: normalized, hostPath: drivePath, mapped: "windows" };
  }

  const segments = normalized.split("/").filter(Boolean);
  const suffix = segments.length > 0 ? `\\${segments.join("\\")}` : "";
  return {
    linuxPath: normalized,
    hostPath: `\\\\${uncHost}\\${distro}${suffix}`,
    mapped: "unc",
  };
}

/** `E:\...` / `E:/...` (a drive letter followed by a separator or the end of the string). */
const DRIVE_PATH_PATTERN = /^([A-Za-z]):(?:[\\/](.*))?$/;

/**
 * Convert a Windows drive path into the Linux path mounted under `options.mountRoot`.
 *
 * @param {string} hostPath e.g. `E:\source`, `E:\`, `E:/source`
 * @param {{mountRoot?: string}} [options]
 * @returns {{linuxPath: string}|undefined} `undefined` when this is not a drive path
 */
export function drivePathToLinux(hostPath, options = {}) {
  if (typeof hostPath !== "string") {
    return undefined;
  }

  const match = DRIVE_PATH_PATTERN.exec(hostPath.trim());
  if (!match) {
    return undefined;
  }

  const mountRoot = normalizeMountRoot(options?.mountRoot);
  const base = mountRoot === "/" ? "" : mountRoot;
  const segments = (match[2] ?? "").replaceAll("\\", "/").split("/").filter(Boolean);
  const suffix = segments.length > 0 ? `/${segments.join("/")}` : "";
  return { linuxPath: normalizeLinuxPath(`${base}/${match[1].toLowerCase()}${suffix}`) };
}

/**
 * Convert any supported Windows host path into a Linux path.
 * Tries WSL UNC first (which also yields the distro name), then a drive path.
 *
 * @param {string} hostPath
 * @param {{mountRoot?: string}} [options]
 * @returns {{linuxPath: string, distro?: string}|undefined}
 */
export function hostPathToLinuxPath(hostPath, options = {}) {
  const parsed = parseWslHostPath(hostPath);
  if (parsed !== undefined) {
    return { linuxPath: parsed.linuxPath, distro: parsed.distro };
  }

  const drive = drivePathToLinux(hostPath, options);
  if (drive !== undefined) {
    return { linuxPath: drive.linuxPath };
  }

  return undefined;
}

/**
 * Parent directory of a Linux path; the root is its own parent.
 * Non-throwing: invalid input falls back to `/`.
 *
 * @param {string} linuxPath
 * @returns {string}
 */
export function parentLinuxPath(linuxPath) {
  const normalized = normalizeLinuxPathOrNull(linuxPath) ?? "/";
  if (normalized === "/") {
    return "/";
  }
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

/**
 * Build the breadcrumb trail for a Linux path: the distro is the root crumb, followed by one crumb
 * per path segment with its cumulative path. The root tail contributes no extra crumb.
 *
 * @param {string} linuxPath
 * @param {string} distro
 * @returns {{name: string, path: string}[]} e.g. `/home/mingfai` -> distro, home, mingfai
 */
export function linuxCrumbs(linuxPath, distro) {
  /** @type {{name: string, path: string}[]} */
  const crumbs = [{ name: typeof distro === "string" ? distro : "", path: "/" }];
  const normalized = normalizeLinuxPathOrNull(linuxPath);
  if (normalized === null) {
    return crumbs;
  }

  let current = "";
  for (const segment of normalized.split("/").filter(Boolean)) {
    current += `/${segment}`;
    crumbs.push({ name: segment, path: current });
  }
  return crumbs;
}

/**
 * Whether a Linux-side name is hidden (dot-prefixed). Mirrors the hide rule `name.startsWith('.')`.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function hiddenByRule(name) {
  return typeof name === "string" && name.startsWith(".");
}

/**
 * Build the canonical JSON key for a Windows host path: lowercase, backslash-normalized, without
 * trailing separators (except the drive root `e:\`, which must stay a valid directory prefix).
 *
 * @param {string} path
 * @returns {string}
 */
export function hostPathKey(path) {
  if (typeof path !== "string" || path.length === 0) {
    return "";
  }

  let key = path.replaceAll("/", "\\").toLowerCase();
  while (key.length > 3 && key.endsWith("\\")) {
    key = key.slice(0, -1);
  }
  return key;
}

/**
 * Case-insensitive, separator-aware containment check for Windows host paths.
 * Equal paths count as inside.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isPathInsideHost(parent, child) {
  if (typeof parent !== "string" || typeof child !== "string") {
    return false;
  }

  const parentKey = hostPathKey(parent);
  const childKey = hostPathKey(child);
  if (parentKey === childKey) {
    return true;
  }
  if (parentKey === "") {
    return false;
  }

  // A trailing separator keeps `C:\ab` from matching `C:\abc`; the drive root already ends in one.
  return childKey.startsWith(parentKey.endsWith("\\") ? parentKey : `${parentKey}\\`);
}

/**
 * @param {string} path
 * @returns {boolean} true only for drive paths (`E:\...` / `E:/...`), never for UNC paths
 */
export function isWindowsDrivePath(path) {
  return typeof path === "string" && /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Remove a trailing inline `# ...` / `; ...` comment and surrounding quotes from an INI value.
 *
 * @param {string} value
 * @returns {string}
 */
function stripInlineComment(value) {
  const commentMatch = /\s[#;]/.exec(value);
  const withoutComment = commentMatch ? value.slice(0, commentMatch.index) : value;
  const trimmed = withoutComment.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Minimal INI reader for /etc/wsl.conf: section names and keys are case-insensitive, comments start
 * with `#` or `;`, later duplicate keys win. Values keep their literal text (inline comments and
 * matching quotes are stripped).
 *
 * @param {string} text
 * @returns {Map<string, Map<string, string>>}
 */
function parseIniSections(text) {
  /** @type {Map<string, Map<string, string>>} */
  const sections = new Map();
  if (typeof text !== "string" || text.length === 0) {
    return sections;
  }

  let currentSection = null;
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      if (!sections.has(currentSection)) {
        sections.set(currentSection, new Map());
      }
      continue;
    }

    if (currentSection === null) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    if (key === "") {
      continue;
    }
    sections.get(currentSection).set(key, stripInlineComment(line.slice(separatorIndex + 1)));
  }

  return sections;
}

/**
 * Read `[automount] root` from /etc/wsl.conf. CRLF, comments, whitespace around `=` and quoted
 * values are tolerated; a missing or empty value means the default `/mnt`.
 *
 * @param {string} text /etc/wsl.conf contents
 * @returns {string}
 */
export function mountRootFromWslConf(text) {
  const root = (parseIniSections(text).get("automount")?.get("root") ?? "").trim();
  return root.length > 0 ? root : DEFAULT_MOUNT_ROOT;
}

/**
 * Read `[user] default` from /etc/wsl.conf.
 *
 * @param {string} text /etc/wsl.conf contents
 * @returns {string|null} trimmed user name, or null when not configured
 */
export function defaultUserFromWslConf(text) {
  const user = (parseIniSections(text).get("user")?.get("default") ?? "").trim();
  return user.length > 0 ? user : null;
}

/**
 * Look up a user's home directory in /etc/passwd contents (exact user-name match, field 6).
 *
 * @param {string} passwdText /etc/passwd contents
 * @param {string} user exact user name
 * @returns {string|null} home directory, or null when the user is absent/unparseable
 */
export function homeFromPasswd(passwdText, user) {
  if (typeof passwdText !== "string" || typeof user !== "string" || user.length === 0) {
    return null;
  }

  for (const rawLine of passwdText.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const fields = line.split(":");
    // name:passwd:uid:gid:gecos:home:shell — the home field requires at least 6 columns.
    if (fields.length < 6 || fields[0] !== user) {
      continue;
    }
    return fields[5];
  }

  return null;
}
