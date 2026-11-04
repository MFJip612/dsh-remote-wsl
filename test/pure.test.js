/**
 * Dependency-free unit tests for `lib/wsl-detect.js` and `lib/wsl-path.js`.
 *
 * No node:test runner and no third-party packages: a tiny `test(name, fn)` harness collects the
 * cases, runs them sequentially (async aware) after module evaluation, prints `PASS n FAIL m` and
 * sets `process.exitCode = 1` when anything failed.
 *
 * Run with the bundled Electron binary used as Node (Node itself is not on PATH):
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'C:\Users\Mingf\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' test\pure.test.js
 */

import assert from "node:assert/strict";

import {
  WSL_DISCOVERY_CACHE_TTL_MS,
  createWslDiscovery,
  createWslExecError,
  decodeWslOutput,
  normalizeWslOutput,
  parseWSLDistroList,
} from "../lib/wsl-detect.js";
import {
  DEFAULT_MOUNT_ROOT,
  defaultUserFromWslConf,
  drivePathToLinux,
  expandTilde,
  hiddenByRule,
  homeFromPasswd,
  hostPathKey,
  hostPathToLinuxPath,
  isAbsoluteLinuxPath,
  isPathInsideHost,
  isValidDistroName,
  isValidWslUser,
  isWindowsDrivePath,
  joinLinux,
  linuxCrumbs,
  linuxToHostPath,
  mountRootFromWslConf,
  normalizeLinuxPath,
  parentLinuxPath,
  parseWslHostPath,
  uncCandidates,
} from "../lib/wsl-path.js";

/** @type {{name: string, fn: () => unknown}[]} */
const tests = [];

/**
 * Register a test case. Async cases may return a promise; the runner awaits every case in order.
 *
 * @param {string} name
 * @param {() => unknown} fn
 */
function test(name, fn) {
  tests.push({ name, fn });
}

/** Realistic `wsl.exe -l -v --all` table (CRLF, two-space column separator). */
const DISTRO_LIST_SAMPLE = [
  "  NAME            STATE           VERSION",
  "* Ubuntu          Running         2",
  "  Debian          Stopped         2",
  "  Alma Linux      Installing      2",
  "",
].join("\r\n");

const EXPECTED_DISTROS = [
  { name: "Ubuntu", isDefault: true, state: "Running", version: 2 },
  { name: "Debian", isDefault: false, state: "Stopped", version: 2 },
  { name: "Alma Linux", isDefault: false, state: "Installing", version: 2 },
];

const PASSWD_SAMPLE = [
  "root:x:0:0:root:/root:/bin/bash",
  "root2:x:0:0:root:/root2:/bin/sh",
  "mingfai:x:1000:1000:Ming Fai,,,:/home/mingfai:/bin/bash",
  "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
  "",
].join("\r\n");

// ---------------------------------------------------------------------------------------------
// lib/wsl-detect.js
// ---------------------------------------------------------------------------------------------

test("decodeWslOutput decodes UTF-16LE output that contains NUL bytes", () => {
  const buffer = Buffer.from(DISTRO_LIST_SAMPLE, "utf16le");
  assert.ok(buffer.includes(0), "fixture must contain NUL bytes");
  assert.equal(decodeWslOutput(buffer), DISTRO_LIST_SAMPLE);
});

test("decodeWslOutput decodes plain UTF-8 output and Uint8Array views", () => {
  assert.equal(decodeWslOutput(Buffer.from("Ubuntu\n", "utf8")), "Ubuntu\n");
  assert.equal(decodeWslOutput(new Uint8Array([0x55, 0x62, 0x75, 0x6e, 0x74, 0x75])), "Ubuntu");
});

test("decodeWslOutput returns '' for empty or missing buffers", () => {
  assert.equal(decodeWslOutput(Buffer.alloc(0)), "");
  assert.equal(decodeWslOutput(new Uint8Array(0)), "");
  assert.equal(decodeWslOutput(null), "");
  assert.equal(decodeWslOutput(undefined), "");
});

test("normalizeWslOutput removes NULs, a leading BOM and every CR", () => {
  assert.equal(normalizeWslOutput("\uFEFFa\r\nb\u0000c"), "a\nbc");
  assert.equal(normalizeWslOutput("\uFEFF\uFEFFx"), "\uFEFFx");
  assert.equal(normalizeWslOutput(""), "");
});

test("parseWSLDistroList parses the real wsl.exe table (header dropped, * default, space kept)", () => {
  assert.deepEqual(parseWSLDistroList(DISTRO_LIST_SAMPLE), EXPECTED_DISTROS);
});

test("parseWSLDistroList parses a UTF-16LE decode end to end", () => {
  const decoded = decodeWslOutput(Buffer.from(DISTRO_LIST_SAMPLE, "utf16le"));
  assert.deepEqual(parseWSLDistroList(decoded), EXPECTED_DISTROS);
});

test("parseWSLDistroList returns [] for empty output, whitespace and garbage", () => {
  assert.deepEqual(parseWSLDistroList(""), []);
  assert.deepEqual(parseWSLDistroList("\r\n   \r\n"), []);
  assert.deepEqual(parseWSLDistroList("Windows Subsystem for Linux has no installed distributions."), []);
  assert.deepEqual(parseWSLDistroList("  NAME            STATE           VERSION"), []);
  assert.deepEqual(parseWSLDistroList("  Ubuntu          Running         two"), []);
});

test("parseWSLDistroList keeps version 1|2 and reports anything else as null", () => {
  const output = ["  Legacy          Running         1", "  Future          Running         3", ""].join(
    "\n",
  );
  assert.deepEqual(parseWSLDistroList(output), [
    { name: "Legacy", isDefault: false, state: "Running", version: 1 },
    { name: "Future", isDefault: false, state: "Running", version: null },
  ]);
});

test("createWslExecError prefers stderr, then stdout, then error.message and appends the exit code", () => {
  const error = Object.assign(new Error("Command failed: wsl.exe"), { code: 1 });

  const fromStderr = createWslExecError(error, Buffer.from("stdout text"), Buffer.from("stderr text\r\n"));
  assert.equal(fromStderr.message, "stderr text（退出码 1）");
  assert.equal(fromStderr.exitCode, 1);
  assert.equal(fromStderr.cause, error);

  const fromStdout = createWslExecError(
    error,
    Buffer.from("No installed distributions", "utf16le"),
    Buffer.alloc(0),
  );
  assert.equal(fromStdout.message, "No installed distributions（退出码 1）");

  const fromMessage = createWslExecError(new Error("spawn wsl.exe ENOENT"), Buffer.alloc(0), Buffer.alloc(0));
  assert.equal(fromMessage.message, "spawn wsl.exe ENOENT");
  assert.equal(fromMessage.exitCode, undefined);
});

test("createWslDiscovery exposes the documented TTL constant", () => {
  assert.equal(WSL_DISCOVERY_CACHE_TTL_MS, 5000);
});

test("createWslDiscovery.listDistros caches one exec for repeated calls and invalidate() re-runs it", async () => {
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    return Buffer.from(DISTRO_LIST_SAMPLE, "utf16le");
  };

  const discovery = createWslDiscovery({ exec });
  assert.deepEqual(await discovery.listDistros(), EXPECTED_DISTROS);
  assert.deepEqual(await discovery.listDistros(), EXPECTED_DISTROS);
  assert.equal(calls.length, 1, "second call must be served from the cache");
  assert.deepEqual(calls[0], ["-l", "-v", "--all"]);

  discovery.invalidate();
  assert.deepEqual(await discovery.listDistros(), EXPECTED_DISTROS);
  assert.equal(calls.length, 2, "invalidate() must force a fresh exec");
});

test("createWslDiscovery.listDistros expires the cache after ttlMs", async () => {
  let clock = 1_000;
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return Buffer.from(DISTRO_LIST_SAMPLE, "utf16le");
  };

  const discovery = createWslDiscovery({ exec, ttlMs: 100, now: () => clock });
  await discovery.listDistros(); // expiresAt = 1100
  clock = 1_099;
  await discovery.listDistros();
  assert.equal(calls, 1, "still inside the TTL");
  clock = 1_100;
  await discovery.listDistros();
  assert.equal(calls, 2, "TTL boundary must refresh");
});

test("createWslDiscovery.listDistros evicts a rejected probe so the next call retries immediately", async () => {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("wsl.exe exploded");
    }
    return Buffer.from(DISTRO_LIST_SAMPLE, "utf16le");
  };

  const discovery = createWslDiscovery({ exec });
  await assert.rejects(discovery.listDistros(), /exploded/);
  assert.deepEqual(await discovery.listDistros(), EXPECTED_DISTROS);
  assert.equal(calls, 2, "a rejection must not be cached for the TTL");
});

test("createWslDiscovery.isAvailable caches the probe and treats a missing wsl.exe as unavailable", async () => {
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    throw new Error("'wsl.exe' is not recognized as an internal or external command");
  };

  const discovery = createWslDiscovery({ exec });
  assert.equal(await discovery.isAvailable(), false);
  assert.equal(await discovery.isAvailable(), false);
  assert.equal(calls.length, 1, "second probe must be served from the cache");
  assert.deepEqual(calls[0], ["--status"]);
});

test("createWslDiscovery.isAvailable reports true for a successful probe and for other wsl.exe errors", async () => {
  const ok = createWslDiscovery({ exec: async () => Buffer.from("Default Distribution: Ubuntu", "utf8") });
  assert.equal(await ok.isAvailable(), true);

  // WSL exists but reports a problem (e.g. no distro installed) -> still available.
  const otherError = createWslDiscovery({
    exec: async () => {
      throw new Error("WSL_E_DISTRO_NOT_FOUND");
    },
  });
  assert.equal(await otherError.isAvailable(), true);
});

test("createWslDiscovery validates its exec dependency", () => {
  assert.throws(() => createWslDiscovery({}), TypeError);
});

// ---------------------------------------------------------------------------------------------
// lib/wsl-path.js — normalization
// ---------------------------------------------------------------------------------------------

test("normalizeLinuxPath normalizes separators, dot segments and trailing slashes", () => {
  assert.equal(normalizeLinuxPath("/"), "/");
  assert.equal(normalizeLinuxPath("/a/../b"), "/b");
  assert.equal(normalizeLinuxPath("/a//b/"), "/a/b");
  assert.equal(normalizeLinuxPath("a/b"), "/a/b");
  assert.equal(normalizeLinuxPath(".."), "/");
  assert.equal(normalizeLinuxPath("./x/./y"), "/x/y");
  // JS literal '\\\\wsl.localhost\\Ubuntu' is the raw string \\wsl.localhost\Ubuntu.
  assert.equal(normalizeLinuxPath("\\\\wsl.localhost\\Ubuntu"), "/wsl.localhost/Ubuntu");
});

test("normalizeLinuxPath throws invalid-path for empty and control-character input", () => {
  for (const bad of ["", "\u0000", "/a\nb", "/a\u007fb", undefined, null, 42]) {
    assert.throws(
      () => normalizeLinuxPath(bad),
      (error) => error.code === "invalid-path",
      `expected ${String(bad)} to throw invalid-path`,
    );
  }
});

test("joinLinux joins posix segments, expandTilde expands only a leading ~", () => {
  assert.equal(joinLinux("/home/u", "x"), "/home/u/x");
  assert.equal(joinLinux("/home/u", "x/../y"), "/home/u/y");
  // `~` is not joinLinux's business.
  assert.equal(joinLinux("/home/u", "~/x"), "/home/u/~/x");

  assert.equal(expandTilde("~/x", "/home/u"), "/home/u/x");
  assert.equal(expandTilde("~", "/home/u"), "/home/u");
  assert.equal(expandTilde("~", "/"), "/");
  assert.equal(expandTilde("~/x", "/"), "/x");
  assert.equal(expandTilde("/abs", "/home/u"), "/abs");
  assert.equal(expandTilde("~x", "/home/u"), "~x");
});

test("isAbsoluteLinuxPath accepts only rooted posix paths", () => {
  assert.equal(isAbsoluteLinuxPath("/"), true);
  assert.equal(isAbsoluteLinuxPath("/a"), true);
  assert.equal(isAbsoluteLinuxPath(""), false);
  assert.equal(isAbsoluteLinuxPath("a"), false);
  assert.equal(isAbsoluteLinuxPath("C:\\a"), false);
  assert.equal(isAbsoluteLinuxPath(undefined), false);
});

// ---------------------------------------------------------------------------------------------
// lib/wsl-path.js — validation
// ---------------------------------------------------------------------------------------------

test("isValidDistroName enforces the WSL distro-name character rules", () => {
  assert.equal(isValidDistroName("Ubuntu"), true);
  assert.equal(isValidDistroName("Alma Linux"), true);
  assert.equal(isValidDistroName("a".repeat(64)), true);
  assert.equal(isValidDistroName("a".repeat(65)), false);
  assert.equal(isValidDistroName(""), false);
  assert.equal(isValidDistroName(" Ubuntu"), false);
  assert.equal(isValidDistroName("Ubuntu "), false);
  assert.equal(isValidDistroName("U\u0000b"), false);
  assert.equal(isValidDistroName(undefined), false);
  for (const bad of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    assert.equal(isValidDistroName(`U${bad}b`), false, `expected ${bad} to be rejected`);
  }
});

test("isValidWslUser enforces length, control characters and separators (empty is invalid)", () => {
  assert.equal(isValidWslUser("mingfai"), true);
  assert.equal(isValidWslUser("  mingfai  "), true);
  assert.equal(isValidWslUser("a".repeat(64)), true);
  assert.equal(isValidWslUser("a".repeat(65)), false);
  assert.equal(isValidWslUser(""), false);
  assert.equal(isValidWslUser("   "), false);
  assert.equal(isValidWslUser("bad\nuser"), false);
  assert.equal(isValidWslUser("a:b"), false);
  assert.equal(isValidWslUser("a/b"), false);
  assert.equal(isValidWslUser("a\\b"), false);
  assert.equal(isValidWslUser(undefined), false);
});

// ---------------------------------------------------------------------------------------------
// lib/wsl-path.js — UNC <-> Linux
// ---------------------------------------------------------------------------------------------

test("uncCandidates returns both wsl.localhost and wsl$ prefixes (root has no trailing segment)", () => {
  assert.deepEqual(uncCandidates("/home/x", "Ubuntu"), [
    "\\\\wsl.localhost\\Ubuntu\\home\\x",
    "\\\\wsl$\\Ubuntu\\home\\x",
  ]);
  assert.deepEqual(uncCandidates("/", "Ubuntu"), ["\\\\wsl.localhost\\Ubuntu", "\\\\wsl$\\Ubuntu"]);
});

test("parseWslHostPath parses both UNC forms, preserves distro case and defaults the tail to /", () => {
  assert.deepEqual(parseWslHostPath("\\\\wsl.localhost\\Ubuntu\\home\\x"), {
    distro: "Ubuntu",
    linuxPath: "/home/x",
  });
  assert.deepEqual(parseWslHostPath("\\\\wsl$\\Ubuntu\\home\\x"), {
    distro: "Ubuntu",
    linuxPath: "/home/x",
  });
  assert.deepEqual(parseWslHostPath("\\\\WSL.LOCALHOST\\Ubuntu"), { distro: "Ubuntu", linuxPath: "/" });
  assert.deepEqual(parseWslHostPath("\\\\wsl.localhost\\Alma Linux\\home"), {
    distro: "Alma Linux",
    linuxPath: "/home",
  });
  assert.equal(parseWslHostPath("C:\\Users"), undefined);
  assert.equal(parseWslHostPath("\\\\wsl.localhost"), undefined);
  assert.equal(parseWslHostPath("\\\\server\\share"), undefined);
  assert.equal(parseWslHostPath(""), undefined);
});

test("parseWslHostPath round-trips uncCandidates output", () => {
  for (const candidate of uncCandidates("/home/mingfai", "Ubuntu")) {
    assert.deepEqual(parseWslHostPath(candidate), { distro: "Ubuntu", linuxPath: "/home/mingfai" });
  }
  for (const candidate of uncCandidates("/", "Ubuntu")) {
    assert.deepEqual(parseWslHostPath(candidate), { distro: "Ubuntu", linuxPath: "/" });
  }
});

test("linuxToHostPath maps Linux paths under the mount root to Windows drives", () => {
  assert.equal(DEFAULT_MOUNT_ROOT, "/mnt");
  assert.deepEqual(linuxToHostPath("/mnt/e/source", "Ubuntu"), {
    linuxPath: "/mnt/e/source",
    hostPath: "E:\\source",
    mapped: "windows",
  });
  assert.deepEqual(linuxToHostPath("/mnt/e", "Ubuntu"), {
    linuxPath: "/mnt/e",
    hostPath: "E:\\",
    mapped: "windows",
  });
  assert.equal(linuxToHostPath("/mnt/E/source", "Ubuntu").hostPath, "E:\\source");
});

test("linuxToHostPath falls back to UNC for non-mounted Linux paths", () => {
  assert.deepEqual(linuxToHostPath("/home/x", "Ubuntu"), {
    linuxPath: "/home/x",
    hostPath: "\\\\wsl.localhost\\Ubuntu\\home\\x",
    mapped: "unc",
  });
  assert.deepEqual(linuxToHostPath("/", "Ubuntu"), {
    linuxPath: "/",
    hostPath: "\\\\wsl.localhost\\Ubuntu",
    mapped: "unc",
  });
  // The mount root itself has no drive letter, so it stays on the UNC path.
  assert.deepEqual(linuxToHostPath("/mnt", "Ubuntu"), {
    linuxPath: "/mnt",
    hostPath: "\\\\wsl.localhost\\Ubuntu\\mnt",
    mapped: "unc",
  });
});

test("linuxToHostPath honours the mountRoot and uncHost options", () => {
  assert.equal(linuxToHostPath("/mnt2/e/source", "Ubuntu", { mountRoot: "/mnt2" }).hostPath, "E:\\source");
  assert.equal(linuxToHostPath("/mnt/e/source", "Ubuntu", { mountRoot: "/mnt2" }).mapped, "unc");
  assert.equal(
    linuxToHostPath("/home/x", "Ubuntu", { uncHost: "wsl$" }).hostPath,
    "\\\\wsl$\\Ubuntu\\home\\x",
  );
});

test("drivePathToLinux converts drive paths back into mount-root paths", () => {
  assert.deepEqual(drivePathToLinux("E:\\x"), { linuxPath: "/mnt/e/x" });
  assert.deepEqual(drivePathToLinux("E:\\"), { linuxPath: "/mnt/e" });
  assert.deepEqual(drivePathToLinux("e:/x"), { linuxPath: "/mnt/e/x" });
  assert.deepEqual(drivePathToLinux("E:\\a\\..\\b"), { linuxPath: "/mnt/e/b" });
  assert.deepEqual(drivePathToLinux("E:\\x\\y", { mountRoot: "/mnt2" }), { linuxPath: "/mnt2/e/x/y" });
  assert.equal(drivePathToLinux("\\\\wsl.localhost\\Ubuntu\\home"), undefined);
  assert.equal(drivePathToLinux("/mnt/e"), undefined);
  assert.equal(drivePathToLinux(undefined), undefined);
});

test("hostPathToLinuxPath tries UNC first and drive paths second", () => {
  assert.deepEqual(hostPathToLinuxPath("\\\\wsl.localhost\\Ubuntu\\home\\x"), {
    linuxPath: "/home/x",
    distro: "Ubuntu",
  });
  assert.deepEqual(hostPathToLinuxPath("E:\\source"), { linuxPath: "/mnt/e/source" });
  assert.deepEqual(hostPathToLinuxPath("E:\\source", { mountRoot: "/mnt2" }), {
    linuxPath: "/mnt2/e/source",
  });
  assert.equal(hostPathToLinuxPath("\\\\server\\share"), undefined);
  assert.equal(hostPathToLinuxPath("relative\\path"), undefined);
});

// ---------------------------------------------------------------------------------------------
// lib/wsl-path.js — traversal, breadcrumbs, host keys
// ---------------------------------------------------------------------------------------------

test("parentLinuxPath walks up to the root", () => {
  assert.equal(parentLinuxPath("/a/b"), "/a");
  assert.equal(parentLinuxPath("/a"), "/");
  assert.equal(parentLinuxPath("/"), "/");
  assert.equal(parentLinuxPath("/a/b/"), "/a");
  assert.equal(parentLinuxPath(""), "/");
});

test("linuxCrumbs builds the distro-rooted breadcrumb chain", () => {
  const crumbs = linuxCrumbs("/home/mingfai", "Ubuntu");
  assert.deepEqual(
    crumbs.map((crumb) => crumb.name),
    ["Ubuntu", "home", "mingfai"],
  );
  assert.deepEqual(
    crumbs.map((crumb) => crumb.path),
    ["/", "/home", "/home/mingfai"],
  );
  assert.deepEqual(linuxCrumbs("/", "Ubuntu"), [{ name: "Ubuntu", path: "/" }]);
  assert.deepEqual(linuxCrumbs("", "Ubuntu"), [{ name: "Ubuntu", path: "/" }]);
});

test("hiddenByRule flags only dot-prefixed names", () => {
  assert.equal(hiddenByRule(".git"), true);
  assert.equal(hiddenByRule(".hidden"), true);
  assert.equal(hiddenByRule("src"), false);
  assert.equal(hiddenByRule(""), false);
  assert.equal(hiddenByRule(undefined), false);
});

test("hostPathKey lowercases, backslash-normalizes and strips trailing separators", () => {
  assert.equal(hostPathKey("E:\\A\\B\\"), "e:\\a\\b");
  assert.equal(hostPathKey("E:/A/B"), "e:\\a\\b");
  assert.equal(hostPathKey("E:\\"), "e:\\");
  assert.equal(hostPathKey("C:/"), "c:\\");
  assert.equal(hostPathKey(""), "");
});

test("isPathInsideHost is case-insensitive, separator aware and true for equal paths", () => {
  assert.equal(isPathInsideHost("E:\\a", "e:\\a\\b"), true);
  assert.equal(isPathInsideHost("C:\\abc", "C:\\ab"), false);
  assert.equal(isPathInsideHost("C:\\ab", "C:\\abc"), false);
  assert.equal(isPathInsideHost("C:\\a", "C:\\a"), true);
  assert.equal(isPathInsideHost("C:\\A", "c:\\a\\b"), true);
  assert.equal(isPathInsideHost("E:\\", "E:\\x"), true);
  assert.equal(isPathInsideHost("E:\\a\\", "E:\\a\\b"), true);
  assert.equal(isPathInsideHost("", "C:\\a"), false);
});

test("isWindowsDrivePath accepts drive paths only, never UNC", () => {
  assert.equal(isWindowsDrivePath("E:\\source"), true);
  assert.equal(isWindowsDrivePath("E:/source"), true);
  assert.equal(isWindowsDrivePath("E:"), false);
  assert.equal(isWindowsDrivePath("\\\\wsl.localhost\\Ubuntu"), false);
  assert.equal(isWindowsDrivePath("/mnt/e"), false);
  assert.equal(isWindowsDrivePath(undefined), false);
});

// ---------------------------------------------------------------------------------------------
// lib/wsl-path.js — wsl.conf and /etc/passwd parsing
// ---------------------------------------------------------------------------------------------

test("mountRootFromWslConf reads [automount] root and tolerates CRLF, comments, case and quotes", () => {
  assert.equal(mountRootFromWslConf("[automount]\r\nroot = /mnt2\r\nenabled = true\r\n"), "/mnt2");
  assert.equal(mountRootFromWslConf("# comment\r\n[Automount]\r\nRoot=/mnt3 # inline comment\r\n"), "/mnt3");
  assert.equal(mountRootFromWslConf('[automount]\nroot = "/mnt4"\n'), "/mnt4");
  assert.equal(mountRootFromWslConf("[boot]\r\nsystemd=true\r\n"), "/mnt");
  assert.equal(mountRootFromWslConf("[automount]\nroot =\n"), "/mnt");
  assert.equal(mountRootFromWslConf(""), "/mnt");
  assert.equal(mountRootFromWslConf(undefined), "/mnt");
});

test("defaultUserFromWslConf reads [user] default and returns null when absent", () => {
  assert.equal(defaultUserFromWslConf("[user]\r\ndefault=mingfai\r\n"), "mingfai");
  assert.equal(defaultUserFromWslConf('[user]\ndefault = "ming fai" # display name\n'), "ming fai");
  assert.equal(defaultUserFromWslConf("[boot]\nsystemd=true\n"), null);
  assert.equal(defaultUserFromWslConf("[user]\ndefault=\n"), null);
  assert.equal(defaultUserFromWslConf(""), null);
});

test("homeFromPasswd resolves the exact user's home directory", () => {
  assert.equal(homeFromPasswd(PASSWD_SAMPLE, "mingfai"), "/home/mingfai");
  assert.equal(homeFromPasswd(PASSWD_SAMPLE, "root"), "/root");
  assert.equal(homeFromPasswd(PASSWD_SAMPLE, "root2"), "/root2");
  assert.equal(homeFromPasswd(PASSWD_SAMPLE, "ming"), null);
  assert.equal(homeFromPasswd(PASSWD_SAMPLE, ""), null);
  assert.equal(homeFromPasswd("", "mingfai"), null);
  assert.equal(homeFromPasswd(undefined, "mingfai"), null);
});

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error?.stack ?? String(error));
  }
}

console.log(`PASS ${passed} FAIL ${failed}`);
if (failed > 0) {
  process.exitCode = 1;
}
