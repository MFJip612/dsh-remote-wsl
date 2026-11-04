/**
 * WSL discovery primitives: decode `wsl.exe` output, parse `wsl.exe -l -v --all`, and a small
 * injectable discovery cache.
 *
 * Ported from ZCode `packages/server/src/remote/wsl-detect.ts` (see each function for the
 * source line range). This module is deliberately pure and injectable: no DSH/ctx imports, no
 * `node:child_process`; the caller supplies `exec(args) -> Promise<Buffer>`.
 *
 * Output encoding note: `wsl.exe -l -v --all` emits UTF-16LE on Windows, so a naive UTF-8 decode
 * leaves a NUL byte after every ASCII character and every distro line parses as garbage. The
 * decoders below detect NUL bytes and fall back to UTF-16LE while still supporting UTF-8 (e.g.
 * `wsl.exe --status` on some builds, or Linux test fixtures).
 */

export const WSL_DISCOVERY_CACHE_TTL_MS = 5000;

/**
 * Decode raw `wsl.exe` stdout bytes into text.
 * Ported from wsl-detect.ts:10-23.
 *
 * @param {Buffer|Uint8Array|null|undefined} buffer raw bytes; `null`/`undefined` mean "no output"
 * @returns {string} decoded text ('' for empty output)
 */
export function decodeWslOutput(buffer) {
  if (buffer === null || buffer === undefined) {
    return "";
  }

  // Tolerate an exec helper that already decoded its output.
  if (typeof buffer === "string") {
    return buffer;
  }

  const bytes = Buffer.isBuffer(buffer)
    ? buffer
    : ArrayBuffer.isView(buffer)
      ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : Buffer.alloc(0);

  if (bytes.length === 0) {
    return "";
  }

  // wsl.exe commonly returns UTF-16LE. Decoding that as UTF-8 leaves an interleaved NUL byte per
  // ASCII character, so detecting NULs first keeps both encodings working.
  if (bytes.includes(0)) {
    return bytes.toString("utf16le");
  }

  return bytes.toString("utf8");
}

/**
 * Strip the artefacts that survive decoding: stray NULs, a leading BOM and every CR.
 * Ported from wsl-detect.ts:25-30.
 *
 * @param {string} raw decoded text
 * @returns {string}
 */
export function normalizeWslOutput(raw) {
  if (typeof raw !== "string") {
    return "";
  }

  return raw.replaceAll("\u0000", "").replace(/^\uFEFF/, "").replace(/\r/g, "");
}

/**
 * Build the error surfaced when a `wsl.exe` invocation fails.
 * Ported from wsl-detect.ts:32-55.
 *
 * `wsl.exe` frequently writes "no such distribution" style failures to UTF-16 *stdout* while
 * leaving stderr empty, so stderr alone loses the reason. Prefer stderr, then stdout, then the
 * original error message, and append the numeric exit code when one is available.
 *
 * @param {Error|{message?: string, code?: unknown}} error original exec error
 * @param {Buffer|Uint8Array|null} stdout captured stdout
 * @param {Buffer|Uint8Array|null} stderr captured stderr
 * @returns {Error & {exitCode?: number}}
 */
export function createWslExecError(error, stdout, stderr) {
  const detail =
    normalizeWslOutput(decodeWslOutput(stderr)).trim() ||
    normalizeWslOutput(decodeWslOutput(stdout)).trim() ||
    (error instanceof Error
      ? error.message
      : typeof error?.message === "string"
        ? error.message
        : String(error));

  const exitCode = typeof error?.code === "number" ? error.code : undefined;
  return Object.assign(
    new Error(exitCode === undefined ? detail : `${detail}（退出码 ${exitCode}）`, {
      cause: error,
    }),
    exitCode === undefined ? {} : { exitCode },
  );
}

/**
 * Parse the `wsl.exe -l -v --all` table into distro descriptors.
 * Ported from wsl-detect.ts:57-97 (kept byte-for-byte on the parsing rules).
 *
 * The table separates columns with two or more spaces, so splitting on `/\s{2,}/` preserves
 * single-space distro names such as "Alma Linux". The header row is dropped naturally because
 * its trailing "VERSION" token is not a finite integer.
 *
 * @param {string} rawOutput raw or pre-normalized output
 * @returns {{name: string, isDefault: boolean, state: string, version: 1|2|null}[]}
 */
export function parseWSLDistroList(rawOutput) {
  const lines = normalizeWslOutput(rawOutput)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  /** @type {{name: string, isDefault: boolean, state: string, version: 1|2|null}[]} */
  const distros = [];
  for (const line of lines) {
    const parts = line
      .trim()
      .split(/\s{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 3) {
      continue;
    }

    const versionToken = parts.at(-1) ?? "";
    const parsedVersion = Number.parseInt(versionToken, 10);
    if (!Number.isFinite(parsedVersion)) {
      continue;
    }

    const state = parts.at(-2) ?? "";
    const nameToken = parts.slice(0, -2).join(" ").trim();
    const isDefault = nameToken.startsWith("*");
    const name = nameToken.replace(/^\*\s*/, "").trim();
    if (!name) {
      continue;
    }

    distros.push({
      name,
      isDefault,
      state,
      // Only version 1 and 2 are known; anything else is reported as unknown rather than dropped,
      // so the UI can still show the distro.
      version: parsedVersion === 1 || parsedVersion === 2 ? parsedVersion : null,
    });
  }

  return distros;
}

/**
 * Create a per-caller WSL discovery object with a short-lived promise cache.
 *
 * Ported from wsl-detect.ts:124-198, but scoped to the factory instance instead of keyed off the
 * executor (the caller owns a single executor for its lifetime) and without the `win32` platform
 * gate — this module stays pure and lets the caller decide whether WSL can exist at all.
 *
 * Caching rules:
 * - `listDistros()` caches the in-flight/fulfilled promise for `ttlMs`.
 * - A rejected promise is evicted before its rejection reaches the caller, so an explicit retry
 *   after a transient `wsl.exe` failure probes again immediately instead of waiting out the TTL.
 * - `invalidate()` drops both caches.
 *
 * @param {{exec: (args: string[]) => Promise<Buffer|Uint8Array|null>, ttlMs?: number, now?: () => number}} options
 * @returns {{listDistros: () => Promise<{name: string, isDefault: boolean, state: string, version: 1|2|null}[]>, isAvailable: () => Promise<boolean>, invalidate: () => void}}
 */
export function createWslDiscovery({
  exec,
  ttlMs = WSL_DISCOVERY_CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof exec !== "function") {
    throw new TypeError("createWslDiscovery requires an exec(args) function");
  }

  // Each holder is a mutable box so the cached entry can be evicted from inside the loader.
  const distroListHolder = { entry: null };
  const availabilityHolder = { entry: null };

  function getCached(holder, load) {
    const cached = holder.entry;
    if (cached !== null && cached.expiresAt > now()) {
      return cached.promise;
    }

    /** @type {{expiresAt: number, promise: Promise<unknown>}} */
    const entry = { expiresAt: now() + ttlMs, promise: undefined };
    entry.promise = (async () => {
      try {
        return await load();
      } catch (error) {
        // A temporary wsl.exe failure must not be pinned for the whole TTL: evict before the
        // rejection escapes so the next explicit retry really executes again.
        if (holder.entry === entry) {
          holder.entry = null;
        }
        throw error;
      }
    })();
    holder.entry = entry;
    // Parity with the reference implementation: callers that fire-and-forget a probe do not turn
    // a transient failure into an unhandled rejection crash.
    void entry.promise.catch(() => {});
    return entry.promise;
  }

  function listDistros() {
    return getCached(distroListHolder, async () => {
      const output = await exec(["-l", "-v", "--all"]);
      return parseWSLDistroList(decodeWslOutput(output));
    });
  }

  function isAvailable() {
    return getCached(availabilityHolder, async () => {
      try {
        await exec(["--status"]);
        return true;
      } catch (error) {
        // wsl.exe missing entirely means WSL is unavailable; any other failure (e.g. no distro
        // installed) still means the WSL CLI exists. Ported from wsl-detect.ts:176-184.
        const message = error instanceof Error ? error.message : String(error);
        return !/not recognized|enoent/i.test(message);
      }
    });
  }

  function invalidate() {
    distroListHolder.entry = null;
    availabilityHolder.entry = null;
  }

  return { listDistros, isAvailable, invalidate };
}
