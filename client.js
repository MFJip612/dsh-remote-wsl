window.__ModuleLoader__.load({
  id: 'dsh-remote-wsl',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const Fragment = React.Fragment;

    /** Locale namespace owned by this plugin. */
    const NS = 'dshRemoteWsl';
    /** Route prefix of the Host half (root-relative so a nested document URL cannot break it). */
    const API = '/dsh-remote-wsl/';
    /** The two declared `single` holes owned by @deepseek-ai/dsh-client-ui-workspace. */
    const HOLES = ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow'];
    /** The frame overlay where the dialogs render. */
    const OVERLAY = 'shell.overlay';
    /** Plugin-owned stylesheet tag identity. */
    const STYLE_ID = 'dsh-remote-wsl/client.css';
    const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const useSyncExternalStore = typeof React.useSyncExternalStore === 'function' ? React.useSyncExternalStore : null;

    // ---------------------------------------------------------------------
    // Dictionaries
    // ---------------------------------------------------------------------

    const zh = {
      'source.title': '添加工作区',
      'source.local.title': '本地文件夹',
      'source.local.hint': '使用 Windows 目录选择器',
      'source.wsl.title': '连接 WSL',
      'source.wsl.hint': '在 WSL 发行版里选择一个项目',
      'wsl.unavailable': '当前环境不支持 WSL 工作区',
      'distros.title': '连接 WSL',
      'distros.section': '发行版',
      'distros.refresh': '刷新发行版列表',
      'distros.default': '默认',
      'distros.loading': '正在检测 WSL 发行版…',
      'distros.empty': '暂未检测到 WSL 发行版',
      'distro.status.connected': '已连接',
      'distro.status.stopped': '已停止',
      'distro.status.installing': '安装中…',
      'folder.title': '选择项目文件夹',
      'folder.search': '搜索或选择文件夹',
      'folder.useThis': '确认此文件夹',
      'folder.goTo': '跳转到 {path}',
      'folder.showHidden': '显示隐藏文件夹',
      'folder.hideHidden': '隐藏隐藏文件夹',
      'folder.empty': '此文件夹下没有子文件夹',
      'folder.loading': '正在读取…',
      'folder.up': '上一级',
      'folder.truncated': '文件夹过多，仅显示开头部分。',
      'folder.connecting': '正在连接…',
      'folder.symlink': '符号链接',
      'action.cancel': '取消',
      'action.back': '返回',
      'action.confirm': '确认',
      'action.retry': '重试',
      'error.generic': '无法连接 WSL 服务，请重试。',
      'error.distros': '无法获取 WSL 发行版列表',
      'error.list': '无法读取此文件夹',
      'error.picker': '无法打开系统目录选择器',
    };

    const en = {
      'source.title': 'Add workspace',
      'source.local.title': 'Local folder',
      'source.local.hint': 'Use the Windows folder picker',
      'source.wsl.title': 'Connect WSL',
      'source.wsl.hint': 'Pick a project inside a WSL distribution',
      'wsl.unavailable': 'WSL workspaces are not available here',
      'distros.title': 'Connect via WSL',
      'distros.section': 'Distributions',
      'distros.refresh': 'Refresh distributions',
      'distros.default': 'Default',
      'distros.loading': 'Detecting WSL distributions…',
      'distros.empty': 'No WSL distribution detected',
      'distro.status.connected': 'Connected',
      'distro.status.stopped': 'Stopped',
      'distro.status.installing': '{state}',
      'folder.title': 'Choose a project folder',
      'folder.search': 'Search or choose a folder',
      'folder.useThis': 'Use this folder',
      'folder.goTo': 'Go to {path}',
      'folder.showHidden': 'Show hidden folders',
      'folder.hideHidden': 'Hide hidden folders',
      'folder.empty': 'No subfolders here',
      'folder.loading': 'Loading…',
      'folder.up': 'Parent folder',
      'folder.truncated': 'Too many folders to list; only the beginning is shown.',
      'folder.connecting': 'Connecting…',
      'folder.symlink': 'Symbolic link',
      'action.cancel': 'Cancel',
      'action.back': 'Back',
      'action.confirm': 'Confirm',
      'action.retry': 'Retry',
      'error.generic': 'Could not reach the WSL service. Try again.',
      'error.distros': 'Could not load WSL distributions',
      'error.list': 'Could not read this folder',
      'error.picker': 'Could not open the system folder picker',
    };

    // ---------------------------------------------------------------------
    // Plugin-owned stylesheet (theme tokens only for color/radius/font/shadow)
    // ---------------------------------------------------------------------

    const CSS = `
.drw-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}
.drw-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(520px, 100%);
  max-height: 80vh;
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay));
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 14px;
  line-height: 22px;
  box-shadow: var(--dsw-elevation-prominent);
}
.drw-card:focus { outline: none; }
.drw-card-folder { width: min(640px, 100%); }
.drw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 20px 16px 12px 24px;
}
.drw-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.drw-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 0 24px 4px;
}
.drw-body-folder { flex: 1 1 auto; min-height: 0; padding-bottom: 0; }
.drw-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 24px 20px;
}
.drw-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.drw-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.drw-row:disabled { cursor: not-allowed; opacity: 0.4; }
.drw-row:focus-visible,
.drw-crumb:focus-visible,
.drw-icon-button:focus-visible,
.drw-toggle:focus-visible,
.drw-button:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.drw-row-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.drw-row-icon-plain { width: 24px; height: 24px; background: transparent; }
.drw-row-accent { border-color: var(--dsw-alias-border-l2); }
.drw-row-accent .drw-row-icon {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
}
.drw-row-text { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.drw-row-title { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.drw-row-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.drw-row-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drw-row-status { flex: none; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.drw-row-symlink,
.drw-row-chevron { flex: none; display: inline-flex; color: var(--dsw-alias-label-tertiary); }
.drw-row-folder { padding: 8px 10px; }
.drw-badge {
  flex: none;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.drw-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.drw-icon-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.drw-icon-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.drw-icon-button:disabled { cursor: not-allowed; opacity: 0.4; }
.drw-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: transparent;
}
.drw-search:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.drw-search-icon { flex: none; display: inline-flex; color: var(--dsw-alias-label-tertiary); }
.drw-search-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 34px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.drw-search-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.drw-crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  overflow-x: auto;
  scrollbar-width: none;
}
.drw-crumbs::-webkit-scrollbar { display: none; }
.drw-crumb {
  flex: none;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 6px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.drw-crumb:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.drw-crumb-current { color: var(--dsw-alias-label-primary); cursor: default; }
.drw-crumb:disabled { cursor: default; }
.drw-crumb-sep { flex: none; color: var(--dsw-alias-label-tertiary); }
.drw-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; }
.drw-toggle {
  padding: 2px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.drw-toggle[aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.drw-list {
  flex: 1 1 auto;
  min-height: 120px;
  max-height: 44vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.drw-status {
  padding: 16px 4px;
  font-size: 13px;
  line-height: 20px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
}
.drw-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.drw-note { padding: 2px 4px 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.drw-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.drw-button:disabled { cursor: not-allowed; opacity: 0.4; }
.drw-button-outline { border: 0.5px solid var(--dsw-alias-border-l3); }
.drw-button-outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.drw-button-primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
}
.drw-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.drw-spinner {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: inherit;
  animation: drw-spin 0.8s linear infinite;
}
@keyframes drw-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .drw-spinner { animation-duration: 2.4s; }
}
`;

    // ---------------------------------------------------------------------
    // Pure helpers (exported on __test; independent of React and the DOM)
    // ---------------------------------------------------------------------

    /**
     * Normalize the Host distro list into display rows.
     * @param distros - the raw `distros` array from `GET /dsh-remote-wsl/distros`.
     * @returns rows `{ name, isDefault, status, statusKey, state }`; `statusKey` is
     * one of `distro.status.connected|stopped|installing` and `state` carries the
     * raw WSL state for the uncovered case (the English dictionary renders it).
     */
    function mapDistroStatus(distros) {
      const rows = [];
      if (!Array.isArray(distros)) return rows;
      for (const distro of distros) {
        if (distro === null || typeof distro !== 'object') continue;
        const name = typeof distro.name === 'string' ? distro.name.trim() : '';
        if (name === '') continue;
        let status = 'stopped';
        if (distro.status === 'running' || distro.status === 'stopped' || distro.status === 'other') status = distro.status;
        else if (distro.running === true) status = 'running';
        const rawState = typeof distro.state === 'string' && distro.state.trim() !== '' ? distro.state : status;
        rows.push({
          name,
          isDefault: distro.isDefault === true,
          status,
          statusKey: status === 'running'
            ? 'distro.status.connected'
            : status === 'stopped'
              ? 'distro.status.stopped'
              : 'distro.status.installing',
          state: rawState,
        });
      }
      return rows;
    }

    /**
     * Case-insensitive substring filter over the current directory level.
     * A path-like query (`/…`, `~…`) addresses a jump target, so it keeps the
     * level unfiltered; the dialog renders the Go-to row for it.
     * @param entries - directory entries `{ name, path }`.
     * @param query - the search box text.
     * @returns the matching entries (or all entries for an empty/path query).
     */
    function filterEntries(entries, query) {
      if (!Array.isArray(entries)) return [];
      const text = typeof query === 'string' ? query.trim() : '';
      if (text === '' || text.charAt(0) === '/' || text.charAt(0) === '~') return entries.slice();
      const needle = text.toLowerCase();
      return entries.filter((entry) => (
        entry !== null
        && typeof entry === 'object'
        && typeof entry.name === 'string'
        && entry.name.toLowerCase().indexOf(needle) !== -1
      ));
    }

    /**
     * Breadcrumb chain for the dialog. The Host list is root-inclusive and its
     * first crumb is the distro itself (`[{name:'Ubuntu',path:'/'}, …]`), so it
     * is rendered as-is (host spelling preserved, consecutive duplicates
     * collapsed). A listing without crumbs falls back to its distro/path.
     * @param listing - a Host or Host-backed `listDirectory` listing.
     * @returns `[{ name, path }]`.
     */
    function crumbsFromListing(listing) {
      const crumbs = [];
      if (listing === null || typeof listing !== 'object') return crumbs;
      const raw = Array.isArray(listing.crumbs) ? listing.crumbs : [];
      for (const crumb of raw) {
        if (crumb === null || typeof crumb !== 'object') continue;
        const path = typeof crumb.path === 'string' ? crumb.path : '';
        if (path === '') continue;
        const name = typeof crumb.name === 'string' && crumb.name !== '' ? crumb.name : path;
        if (crumbs.length > 0 && crumbs[crumbs.length - 1].path === path) continue;
        crumbs.push({ name, path });
      }
      if (crumbs.length === 0) {
        const distro = typeof listing.distro === 'string' ? listing.distro.trim() : '';
        if (distro !== '') crumbs.push({ name: distro, path: '/' });
        if (typeof listing.path === 'string' && listing.path !== '') crumbs.push({ name: listing.path, path: listing.path });
      }
      return crumbs;
    }

    /**
     * Pick the Host error message out of a `{ error: { code, message } }` payload.
     * @param payload - parsed JSON body (or null/unknown for transport failures).
     * @param t - locale translate function (locale keys resolve through it).
     * @returns the Host message, or the localized generic failure text.
     */
    function formatConnectError(payload, t) {
      const translate = typeof t === 'function' ? t : (key) => key;
      if (payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object') {
        if (typeof payload.error.message === 'string' && payload.error.message.trim() !== '') return payload.error.message;
      }
      if (typeof payload === 'string' && payload.trim() !== '') return payload.trim();
      return translate('error.generic');
    }

    /**
     * Join a Linux path segment onto a base directory and normalize `.`/`..`.
     * @param base - absolute base path, e.g. `/home/mingfai`.
     * @param rel - relative or absolute segment, e.g. `projects` or `/usr/lib`.
     * @returns the normalized absolute path.
     */
    function joinLinuxPath(base, rel) {
      const baseText = typeof base === 'string' ? base : '';
      const relText = typeof rel === 'string' ? rel : '';
      const absolute = relText.charAt(0) === '/';
      const segments = [];
      const eat = (text) => {
        for (const part of String(text).split('/')) {
          if (part === '' || part === '.') continue;
          if (part === '..') {
            if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
            else if (!absolute) segments.push('..');
            continue;
          }
          segments.push(part);
        }
      };
      if (absolute) {
        eat(relText);
        return '/' + segments.join('/');
      }
      eat(baseText);
      eat(relText);
      if (segments.length === 0) return '/';
      return (baseText.charAt(0) === '/' || baseText === '' ? '/' : '') + segments.join('/');
    }

    /**
     * Resolve a path-like search query against the current listing.
     * @param listing - the current listing (its `home` resolves `~`).
     * @param query - the search box text.
     * @returns the target absolute path, or null when the query is not path-like.
     */
    function resolveQueryPath(listing, query) {
      const text = typeof query === 'string' ? query.trim() : '';
      if (text === '') return null;
      const home = listing !== null && typeof listing === 'object' && typeof listing.home === 'string' && listing.home !== ''
        ? listing.home
        : '/';
      if (text === '~') return joinLinuxPath('/', home);
      if (text.slice(0, 2) === '~/') return joinLinuxPath(home, text.slice(2));
      if (text.charAt(0) === '/') return joinLinuxPath('/', text);
      return null;
    }

    /**
     * Read the hidden flag of an entry; Host-backed listings flag it, WSL
     * listings hide by the conventional leading dot.
     * @param entry - one directory entry.
     * @returns whether the entry is a hidden folder.
     */
    function isHiddenEntry(entry) {
      if (entry === null || typeof entry !== 'object') return false;
      if (entry.hidden === true) return true;
      return typeof entry.name === 'string' && entry.name.charAt(0) === '.';
    }

    /**
     * Detect the composed-picker refusal that asks the caller to fall back to an
     * in-app browser, from any nesting shape. `uiWorkspace.pickDirectory()` wraps
     * the Host refusal in a plain Error whose message keeps only the text, e.g.
     * "directory picker failed: directoryPicker.pick needs the native capability;
     * the composed picker serves \"browse\"", while RPC-shaped reasons keep a
     * `directory-picker/unavailable` code.
     * @param error - rejection reason.
     * @returns whether the native picker is unavailable in this composition.
     */
    function isPickerUnavailable(error) {
      const seen = new Set();
      const check = (value, depth) => {
        if (depth > 5 || value === null || value === undefined) return false;
        if (typeof value === 'string') {
          const text = value.toLowerCase();
          return text.indexOf('directory-picker/unavailable') !== -1
            || text.indexOf('needs the native capability') !== -1
            || text.indexOf('needs the browse capability') !== -1
            || (text.indexOf('directory picker') !== -1 && text.indexOf('unavailable') !== -1);
        }
        if (typeof value !== 'object' || seen.has(value)) return false;
        seen.add(value);
        for (const key of ['code', 'name', 'message', 'reason', 'rpcError', 'error', 'cause', 'details']) {
          if (Object.prototype.hasOwnProperty.call(value, key) && check(value[key], depth + 1)) return true;
        }
        return false;
      };
      return check(error, 0);
    }

    /** Extract a readable message from an arbitrary rejection (RPC-shaped reasons included). */
    function failureText(error) {
      if (error !== null && typeof error === 'object') {
        const rpcError = error.rpcError;
        if (rpcError !== null && typeof rpcError === 'object' && typeof rpcError.message === 'string' && rpcError.message !== '') return rpcError.message;
        if (typeof error.message === 'string' && error.message !== '') return error.message;
      }
      if (typeof error === 'string' && error !== '') return error;
      return '';
    }

    // ---------------------------------------------------------------------
    // Minimal observable store
    // ---------------------------------------------------------------------

    /**
     * Create the tiny synchronous observable store used by the flow.
     * @param initial - initial state object.
     * @returns `{ get, set, subscribe }`.
     */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get: () => state,
        set(patch) {
          state = Object.assign({}, state, patch);
          for (const listener of Array.from(listeners)) {
            try {
              listener();
            } catch (error) {
              console.error('dsh-remote-wsl: store listener failed', error);
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    const EMPTY_FLOW = Object.freeze({
      active: false,
      step: 'source',
      mode: 'wsl',
      distro: null,
      status: null,
      distros: null,
      listing: null,
      requestedPath: null,
      search: '',
      showHidden: false,
      confirming: false,
      nativeBusy: false,
      ownerBusy: false,
      error: null,
    });

    /** Bumped on every begin/clear so late HTTP settlements are dropped. */
    let flowEpoch = 0;
    /** Pending listing request controller (absent where AbortController is unavailable). */
    let listingAbort = null;
    /** The injected `uiWorkspace` service, captured in `apply`. */
    let workspaceService = null;
    /** The injected native pick function, captured in `apply`. */
    let pickNativeImpl = null;

    function abortListing() {
      if (listingAbort === null) return;
      try {
        listingAbort.abort();
      } catch (error) {
        /* already settled */
      }
      listingAbort = null;
    }

    /**
     * Create the module-level flow store. `begin` snapshots a handlers source so
     * every read uses the owner's LATEST props (the bridge refreshes it per render).
     */
    function createFlowStore() {
      const store = createStore(EMPTY_FLOW);
      let handlersSource = null;
      return {
        get: store.get,
        set: store.set,
        subscribe: store.subscribe,
        begin(source) {
          flowEpoch += 1;
          abortListing();
          handlersSource = typeof source === 'function' ? source : () => (source !== null && typeof source === 'object' ? source : {});
          store.set(Object.assign({}, EMPTY_FLOW, { active: true }));
        },
        clear() {
          flowEpoch += 1;
          abortListing();
          handlersSource = null;
          store.set(Object.assign({}, EMPTY_FLOW));
        },
        handlers() {
          if (typeof handlersSource !== 'function') return {};
          try {
            const value = handlersSource();
            return value !== null && typeof value === 'object' ? value : {};
          } catch (error) {
            return {};
          }
        },
      };
    }

    const flowStore = createFlowStore();

    // ---------------------------------------------------------------------
    // HTTP client
    // ---------------------------------------------------------------------

    function apiError(kind, payload) {
      const error = new Error(kind === 'network' ? 'dsh-remote-wsl: network failure' : 'dsh-remote-wsl: request rejected');
      error.drw = { kind, payload };
      return error;
    }

    function payloadOf(error) {
      if (error !== null && typeof error === 'object') {
        if (error.drw && Object.prototype.hasOwnProperty.call(error.drw, 'payload')) return error.drw.payload;
        if (Object.prototype.hasOwnProperty.call(error, 'payload')) return error.payload;
      }
      return null;
    }

    /** Localized text for a failed data request (payload message first). */
    function listErrorText(error, t, fallbackKey) {
      const translate = typeof t === 'function' ? t : (key) => key;
      const fallback = () => translate(fallbackKey || 'error.generic');
      if (error !== null && typeof error === 'object' && error.drw) {
        const payload = payloadOf(error);
        if (payload !== null && typeof payload === 'object') {
          if (payload.error !== null && typeof payload.error === 'object' && typeof payload.error.message === 'string' && payload.error.message !== '') return payload.error.message;
          if (typeof payload.message === 'string' && payload.message !== '') return payload.message;
        }
        return fallback();
      }
      const text = failureText(error);
      return text !== '' ? text : fallback();
    }

    /**
     * Fetch a Host JSON route; non-2xx turns into an error carrying the parsed body.
     * @param url - document-relative route (e.g. `dsh-remote-wsl/status`).
     * @param init - optional fetch init.
     * @returns parsed JSON payload.
     */
    async function fetchJson(url, init) {
      let response;
      try {
        response = await fetch(url, Object.assign({ credentials: 'same-origin' }, init || {}));
      } catch (error) {
        throw apiError('network', null);
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (!response.ok) throw apiError('http', payload);
      return payload;
    }

    function distroListUrl(distro, path) {
      const params = ['distro=' + encodeURIComponent(distro)];
      if (typeof path === 'string' && path !== '') params.push('path=' + encodeURIComponent(path));
      params.push('hidden=1');
      return API + 'list?' + params.join('&');
    }

    // ---------------------------------------------------------------------
    // Flow data operations
    // ---------------------------------------------------------------------

    function loadStatus(t) {
      const epoch = flowEpoch;
      flowStore.set({ status: { loading: true, available: null, error: null } });
      fetchJson(API + 'status').then((payload) => {
        if (epoch !== flowEpoch) return;
        const value = payload !== null && typeof payload === 'object' ? payload : {};
        flowStore.set({
          status: {
            loading: false,
            available: value.available === true,
            platform: typeof value.platform === 'string' ? value.platform : '',
            defaultDistro: typeof value.defaultDistro === 'string' ? value.defaultDistro : null,
            error: typeof value.error === 'string' && value.error !== '' ? value.error : null,
          },
        });
      }, (error) => {
        if (epoch !== flowEpoch) return;
        flowStore.set({ status: { loading: false, available: false, error: listErrorText(error, t, 'error.generic') } });
      });
    }

    function loadDistros(t, refresh) {
      const epoch = flowEpoch;
      const current = flowStore.get().distros;
      const keep = refresh === true && current !== null && typeof current === 'object' && current.data !== null
        ? current.data
        : null;
      flowStore.set({ distros: { loading: true, error: null, data: keep } });
      fetchJson(API + 'distros' + (refresh === true ? '?refresh=1' : '')).then((payload) => {
        if (epoch !== flowEpoch) return;
        const value = payload !== null && typeof payload === 'object' ? payload : {};
        if (value.available === false) {
          flowStore.set({
            distros: {
              loading: false,
              data: null,
              error: typeof value.error === 'string' && value.error !== '' ? value.error : t('error.distros'),
            },
          });
          return;
        }
        flowStore.set({ distros: { loading: false, error: null, data: value } });
      }, (error) => {
        if (epoch !== flowEpoch) return;
        flowStore.set({ distros: { loading: false, data: null, error: listErrorText(error, t, 'error.distros') } });
      });
    }

    function openDistrosStep(t) {
      flowStore.set({ step: 'distros', error: null, distros: { loading: true, error: null, data: null } });
      loadDistros(t, false);
    }

    function backToDistros(t) {
      abortListing();
      const distros = flowStore.get().distros;
      flowStore.set({ step: 'distros', error: null });
      if (distros === null || typeof distros !== 'object' || (distros.data === null && distros.loading !== true && !distros.error)) loadDistros(t, false);
    }

    function warmDistro(name) {
      try {
        Promise.resolve(fetchJson(API + 'warm?distro=' + encodeURIComponent(name))).catch(() => {});
      } catch (error) {
        /* fire and forget */
      }
    }

    /**
     * List one folder level in the active mode and publish the outcome.
     * @param t - locale translator.
     * @param path - absolute folder path, or null to list the default/home level.
     */
    function loadListing(t, path) {
      abortListing();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      listingAbort = controller;
      const epoch = flowEpoch;
      const state = flowStore.get();
      const mode = state.mode === 'local' ? 'local' : 'wsl';
      const distro = typeof state.distro === 'string' ? state.distro : '';
      const target = typeof path === 'string' && path.trim() !== '' ? path.trim() : null;
      flowStore.set({ requestedPath: target, search: '', listing: { loading: true, error: null, data: null } });

      const fail = (error) => {
        if (epoch !== flowEpoch || listingAbort !== controller) return;
        listingAbort = null;
        flowStore.set({ listing: { loading: false, error: listErrorText(error, t, 'error.list'), data: null } });
      };

      let request;
      if (mode === 'local') {
        const service = workspaceService;
        if (service === null || typeof service.listDirectory !== 'function') {
          fail(apiError('unavailable', { error: { message: t('error.picker') } }));
          return;
        }
        try {
          request = Promise.resolve(service.listDirectory(
            target === null ? undefined : target,
            controller === null ? undefined : controller.signal,
          ));
        } catch (error) {
          fail(error);
          return;
        }
      } else {
        if (distro === '') {
          fail(apiError('unavailable', null));
          return;
        }
        request = fetchJson(distroListUrl(distro, target), controller === null ? undefined : { signal: controller.signal });
      }

      request.then((payload) => {
        if (epoch !== flowEpoch || listingAbort !== controller) return;
        listingAbort = null;
        const value = payload !== null && typeof payload === 'object' ? payload : {};
        if (value.error !== null && typeof value.error === 'object') {
          const message = typeof value.error.message === 'string' && value.error.message !== '' ? value.error.message : t('error.list');
          flowStore.set({ listing: { loading: false, error: message, data: null } });
          return;
        }
        flowStore.set({ listing: { loading: false, error: null, data: value } });
      }, fail);
    }

    function openFolderStep(t, options) {
      const opts = options !== null && typeof options === 'object' ? options : {};
      const path = typeof opts.path === 'string' && opts.path !== '' ? opts.path : null;
      flowStore.set({
        step: 'folder',
        mode: opts.mode === 'local' ? 'local' : 'wsl',
        distro: typeof opts.distro === 'string' && opts.distro !== '' ? opts.distro : null,
        search: '',
        showHidden: false,
        confirming: false,
        error: null,
        requestedPath: path,
        listing: { loading: true, error: null, data: null },
      });
      loadListing(t, path);
    }

    function retryListing(t) {
      const state = flowStore.get();
      if (state.step !== 'folder') return;
      loadListing(t, state.requestedPath);
    }

    function backFromFolder(t) {
      if (flowStore.get().mode === 'local') {
        abortListing();
        flowStore.set({ step: 'source', error: null });
        return;
      }
      backToDistros(t);
    }

    function goBack(t) {
      const state = flowStore.get();
      if (state.step === 'folder') {
        backFromFolder(t);
        return;
      }
      if (state.step === 'distros') {
        flowStore.set({ step: 'source', error: null });
        return;
      }
      cancelFlow();
    }

    // ---------------------------------------------------------------------
    // Owner conversation outcomes
    // ---------------------------------------------------------------------

    function finishPicked(workspacePath) {
      const handlers = flowStore.handlers();
      flowStore.clear();
      if (typeof handlers.onPicked === 'function') {
        try {
          handlers.onPicked(workspacePath);
        } catch (error) {
          console.error('dsh-remote-wsl: onPicked failed', error);
        }
      }
    }

    function cancelFlow() {
      const handlers = flowStore.handlers();
      flowStore.clear();
      if (typeof handlers.onCancel === 'function') {
        try {
          handlers.onCancel();
        } catch (error) {
          console.error('dsh-remote-wsl: onCancel failed', error);
        }
      }
    }

    function failFlow(message) {
      const handlers = flowStore.handlers();
      flowStore.clear();
      if (typeof handlers.onError === 'function') {
        try {
          handlers.onError(message);
        } catch (error) {
          console.error('dsh-remote-wsl: onError failed', error);
        }
      }
    }

    function pickedPathOf(value) {
      if (typeof value === 'string') return value !== '' ? value : null;
      if (value !== null && typeof value === 'object' && typeof value.path === 'string' && value.path !== '') return value.path;
      return null;
    }

    /**
     * Row 1 of the entry dialog: run the composed native picker. A rejected
     * `directory-picker/unavailable` opens the same browser component in local
     * mode; a resolved path fulfils the owner conversation; `null` is a cancel.
     */
    async function pickLocalFolder(t) {
      if (flowStore.get().nativeBusy === true) return;
      flowStore.set({ nativeBusy: true, error: null });
      try {
        const picked = await pickNativeImpl();
        const path = pickedPathOf(picked);
        if (path !== null) {
          finishPicked(path);
          return;
        }
        // A null/undefined resolution is the OS dialog's own cancellation:
        // keep the entry dialog open so the user can choose again.
      } catch (error) {
        if (isPickerUnavailable(error)) {
          openFolderStep(t, { mode: 'local', distro: null, path: null });
          return;
        }
        const text = failureText(error);
        failFlow(text !== '' ? text : t('error.picker'));
      } finally {
        if (flowStore.get().active === true) flowStore.set({ nativeBusy: false });
      }
    }

    /** Enter the in-app folder browser for one WSL distro. */
    function pickDistro(t, name) {
      if (typeof name !== 'string' || name === '') return;
      warmDistro(name);
      openFolderStep(t, { mode: 'wsl', distro: name, path: null });
    }

    /** POST the chosen folder to the Host; success hands the mapped path to the owner. */
    async function confirmFolder(t) {
      const state = flowStore.get();
      if (state.confirming === true) return;
      const listing = state.listing !== null && typeof state.listing === 'object' ? state.listing.data : null;
      if (listing === null || typeof listing !== 'object' || typeof listing.path !== 'string' || listing.path === '') return;
      if (state.mode === 'local') {
        finishPicked(listing.path);
        return;
      }
      const epoch = flowEpoch;
      const distro = typeof state.distro === 'string' ? state.distro : '';
      flowStore.set({ confirming: true, error: null });
      try {
        const payload = await fetchJson(API + 'connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ distro, linuxPath: listing.path }),
        });
        if (epoch !== flowEpoch) return;
        const workspacePath = payload !== null && typeof payload === 'object' && typeof payload.workspacePath === 'string'
          ? payload.workspacePath
          : '';
        if (workspacePath === '') {
          flowStore.set({ confirming: false, error: formatConnectError(payload, t) });
          return;
        }
        finishPicked(workspacePath);
      } catch (error) {
        if (epoch !== flowEpoch) return;
        flowStore.set({ confirming: false, error: formatConnectError(payloadOf(error), t) });
      }
    }

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------

    function icon(size, children) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size === undefined ? 16 : size,
        height: size === undefined ? 16 : size,
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      }, children);
    }

    function FolderIcon(props) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: props.size || 16,
        height: props.size || 16,
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block' },
      },
      h('path', {
        d: 'M1.5 3.75c0-.69.56-1.25 1.25-1.25h2.7c.33 0 .65.13.88.37l1.12 1.13h5.8c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25h-10.5c-.69 0-1.25-.56-1.25-1.25z',
        fill: 'currentColor',
      }));
    }

    function TerminalIcon(props) {
      return icon(props.size || 16, [
        h('rect', {
          key: 'frame',
          x: 1.75, y: 2.75, width: 12.5, height: 10.5, rx: 1.5,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.1,
        }),
        h('path', {
          key: 'prompt',
          d: 'M4.6 6.2 6.6 8l-2 1.8M8.6 10.2h2.8',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.1,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      ]);
    }

    function RefreshIcon(props) {
      return icon(props.size || 14, h('path', {
        d: 'M13 8a5 5 0 1 1-1.46-3.54M13.2 2.2v2.9h-2.9',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    function SearchIcon(props) {
      return icon(props.size || 14, [
        h('circle', { key: 'c', cx: 7, cy: 7, r: 4.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { key: 'l', d: 'm10.2 10.2 3.4 3.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      ]);
    }

    function CheckIcon(props) {
      return icon(props.size || 14, h('path', {
        d: 'm2.8 8.4 3.2 3.2 7.2-7.2',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    function UpIcon(props) {
      return icon(props.size || 12, h('path', {
        d: 'M8 13V3.5M4.2 7.2 8 3.4l3.8 3.8',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    function ChevronIcon(props) {
      return icon(props.size || 12, h('path', {
        d: 'm6 3.5 4.5 4.5L6 12.5',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    function GoIcon(props) {
      return icon(props.size || 14, [
        h('path', {
          key: 'a',
          d: 'M2.5 8h10M9 4.5 12.5 8 9 11.5',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      ]);
    }

    function Spinner(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 14;
      return h('span', { className: 'drw-spinner', 'aria-hidden': true, style: { width: size, height: size } },
        h('svg', {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h('circle', {
          cx: 8,
          cy: 8,
          r: 6.4,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeDasharray: '26 14',
          strokeLinecap: 'round',
        })));
    }

    // ---------------------------------------------------------------------
    // Shared UI atoms
    // ---------------------------------------------------------------------

    function Button(props) {
      const variant = props.variant === 'primary' ? ' drw-button-primary' : props.variant === 'outline' ? ' drw-button-outline' : '';
      return h('button', {
        type: 'button',
        className: 'drw-button' + variant,
        disabled: props.disabled === true,
        onClick: props.onClick,
        'aria-label': props.ariaLabel,
      }, props.children);
    }

    function DialogHeader(props) {
      return h('div', { className: 'drw-header' }, h('h2', { className: 'drw-title' }, props.title));
    }

    function DialogFooter(props) {
      return h('div', { className: 'drw-footer' }, props.children);
    }

    // ---------------------------------------------------------------------
    // Flow components
    // ---------------------------------------------------------------------

    function stepTitle(step, t) {
      if (step === 'distros') return t('distros.title');
      if (step === 'folder') return t('folder.title');
      return t('source.title');
    }

    function fallbackTranslate(key) {
      return key;
    }

    /** Subscribe an overlay render to the module store (uSES when available). */
    function useFlowState(store) {
      const subscribe = React.useCallback((listener) => store.subscribe(listener), [store]);
      const getSnapshot = React.useCallback(() => store.get(), [store]);
      const [fallback, setFallback] = React.useState(getSnapshot);
      React.useEffect(() => {
        if (useSyncExternalStore !== null) return undefined;
        setFallback(store.get());
        return store.subscribe(() => setFallback(store.get()));
      }, [store]);
      if (useSyncExternalStore !== null) return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      return fallback;
    }

    /**
     * The directory-flow occupant: renderless. It mirrors the owner's `open`
     * edge into the module store and keeps the store's handler source pointed at
     * the newest props, so late settlements never call stale callbacks.
     */
    function FlowBridge(rawProps) {
      const props = rawProps !== null && typeof rawProps === 'object' ? rawProps : {};
      const store = props.store !== null && typeof props.store === 'object' && typeof props.store.begin === 'function' ? props.store : flowStore;
      const propsRef = React.useRef(props);
      propsRef.current = props;
      // Two surfaces own this hole (sidebar and the empty-state hero) and both
      // bridges are mounted at once, so only the instance that actually opened
      // the conversation may clear it; an idle sibling must never wipe it.
      const begun = React.useRef(false);
      const open = props.open === true;
      React.useEffect(() => {
        if (open) {
          begun.current = true;
          store.begin(() => propsRef.current);
        } else if (begun.current) {
          begun.current = false;
          store.clear();
        }
      }, [open, store]);
      React.useEffect(() => {
        if (open) store.set({ ownerBusy: props.busy === true });
      }, [open, props.busy, store]);
      React.useEffect(() => () => {
        if (!begun.current) return;
        begun.current = false;
        store.clear();
      }, [store]);
      return null;
    }

    /**
     * The frame-overlay occupant: renders nothing while no flow is active and
     * portals the current step's dialog to the document body otherwise.
     */
    function FlowOverlay(rawProps) {
      const props = rawProps !== null && typeof rawProps === 'object' ? rawProps : {};
      const store = props.store !== null && typeof props.store === 'object' && typeof props.store.get === 'function' ? props.store : flowStore;
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
      const state = useFlowState(store);
      if (state === null || typeof state !== 'object' || state.active !== true) return null;
      if (typeof document === 'undefined' || document.body === null || document.body === undefined) return null;
      let node = null;
      try {
        node = h(FlowRoot, { store, state, t });
      } catch (error) {
        console.error('dsh-remote-wsl: flow render failed', error);
        return null;
      }
      try {
        return ReactDOM.createPortal(node, document.body);
      } catch (error) {
        return null;
      }
    }

    function trapTab(event, root) {
      if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return;
      const nodes = Array.prototype.slice.call(root.querySelectorAll(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (event.shiftKey === true) {
        if (active === first || (active !== null && !root.contains(active))) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || (active !== null && !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    /** The active dialog: shared chrome, focus management, and step switching. */
    function FlowRoot(props) {
      const store = props.store;
      const state = props.state !== null && typeof props.state === 'object' ? props.state : {};
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
      const cardRef = React.useRef(null);
      const step = state.step === 'distros' || state.step === 'folder' ? state.step : 'source';
      const title = stepTitle(step, t);
      const busy = state.ownerBusy === true || state.confirming === true || state.nativeBusy === true;

      React.useEffect(() => {
        const card = cardRef.current;
        if (card === null || card === undefined || typeof card.querySelector !== 'function') return;
        let target = card.querySelector('[data-drw-autofocus]');
        if (target === null || target === undefined || target.disabled === true) target = card.querySelector(FOCUSABLE);
        if (target !== null && target !== undefined && typeof target.focus === 'function') {
          try {
            target.focus({ preventScroll: true });
          } catch (error) {
            try {
              target.focus();
            } catch (nested) {
              /* focus is best-effort */
            }
          }
        }
      }, [step]);

      // Escape must work even after focus lands on a non-focusable part of the
      // card, so the step-back key rides a document listener for the dialog's
      // lifetime instead of the card's bubbled key handler.
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const onEscape = (event) => {
          if (event === null || event === undefined || event.key !== 'Escape' || event.isComposing === true) return;
          event.preventDefault();
          goBack(t);
        };
        document.addEventListener('keydown', onEscape);
        return () => document.removeEventListener('keydown', onEscape);
      }, [t]);

      const onKeyDown = (event) => {
        if (event === null || event === undefined) return;
        if (event.key !== 'Tab') return;
        trapTab(event, cardRef.current);
      };

      const onBackdropMouseDown = (event) => {
        if (event === null || event === undefined) return;
        if (event.target === event.currentTarget) cancelFlow();
      };

      const children = step === 'folder'
        ? h(FolderDialog, { state, t, busy })
        : step === 'distros'
          ? h(DistroDialog, { state, t, busy })
          : h(SourceDialog, { state, t, busy });

      return h('div', { className: 'drw-backdrop', onMouseDown: onBackdropMouseDown },
        h('div', {
          className: 'drw-card' + (step === 'folder' ? ' drw-card-folder' : ''),
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
          tabIndex: -1,
          ref: cardRef,
          onKeyDown,
        }, children));
    }

    /** Step 1: the two-row entry dialog. */
    function SourceDialog(props) {
      const state = props.state !== null && typeof props.state === 'object' ? props.state : {};
      const t = props.t;
      React.useEffect(() => {
        loadStatus(t);
      }, []);
      const status = state.status !== null && typeof state.status === 'object' ? state.status : null;
      const loading = status === null || status.loading === true;
      const available = status !== null && status.available === true;
      const unavailable = status !== null && status.loading !== true && !available;
      const reason = status !== null && typeof status.error === 'string' && status.error !== '' ? status.error : t('wsl.unavailable');
      const busy = state.ownerBusy === true || state.nativeBusy === true;
      return h(Fragment, null,
        h(DialogHeader, { title: t('source.title') }),
        h('div', { className: 'drw-body' },
          h('button', {
            type: 'button',
            className: 'drw-row',
            'data-drw-autofocus': true,
            disabled: busy,
            onClick: () => {
              void pickLocalFolder(t);
            },
          },
          h('span', { className: 'drw-row-icon' }, h(FolderIcon, { size: 18 })),
          h('span', { className: 'drw-row-text' },
            h('span', { className: 'drw-row-title' }, t('source.local.title')),
            h('span', { className: 'drw-row-hint' }, t('source.local.hint'))),
          state.nativeBusy === true ? h(Spinner, { size: 14 }) : null),
          h('button', {
            type: 'button',
            className: 'drw-row drw-row-accent',
            disabled: busy || loading || !available,
            onClick: () => {
              openDistrosStep(t);
            },
          },
          h('span', { className: 'drw-row-icon' }, h(TerminalIcon, { size: 18 })),
          h('span', { className: 'drw-row-text' },
            h('span', { className: 'drw-row-title' }, t('source.wsl.title')),
            h('span', { className: 'drw-row-hint' }, t('source.wsl.hint'))),
          loading ? h(Spinner, { size: 14 }) : null),
          unavailable ? h('div', { className: 'drw-note', role: 'note' }, reason) : null,
          typeof state.error === 'string' && state.error !== '' ? h('div', { className: 'drw-error', role: 'alert' }, state.error) : null),
        h(DialogFooter, null,
          h(Button, { variant: 'outline', disabled: busy, onClick: cancelFlow }, t('action.cancel'))));
    }

    /** Step 2: distro picker. */
    function DistroDialog(props) {
      const state = props.state !== null && typeof props.state === 'object' ? props.state : {};
      const t = props.t;
      const busy = props.busy === true;
      const box = state.distros !== null && typeof state.distros === 'object' ? state.distros : null;
      const payload = box !== null && box.data !== null && typeof box.data === 'object' ? box.data : null;
      const loading = box === null || box.loading === true;
      const error = box !== null && typeof box.error === 'string' && box.error !== '' ? box.error : null;
      const rows = mapDistroStatus(payload !== null && Array.isArray(payload.distros) ? payload.distros : null);
      const defaultDistro = payload !== null && typeof payload.defaultDistro === 'string' ? payload.defaultDistro : null;
      let body;
      if (error !== null) {
        body = h('div', { className: 'drw-error', role: 'alert' }, error,
          h(Button, { variant: 'outline', disabled: busy, onClick: () => { loadDistros(t, true); } }, t('action.retry')));
      } else if (loading && rows.length === 0) {
        body = h('div', { className: 'drw-status', role: 'status' }, t('distros.loading'));
      } else if (rows.length === 0) {
        body = h('div', { className: 'drw-status' }, t('distros.empty'));
      } else {
        body = rows.map((row) => h('button', {
          key: row.name,
          type: 'button',
          className: 'drw-row',
          disabled: busy,
          onClick: () => {
            pickDistro(t, row.name);
          },
        },
        h('span', { className: 'drw-row-icon' }, h(TerminalIcon, { size: 18 })),
        h('span', { className: 'drw-row-name' }, row.name),
        row.isDefault === true || row.name === defaultDistro
          ? h('span', { className: 'drw-badge' }, t('distros.default'))
          : null,
        h('span', { className: 'drw-row-status' }, t(row.statusKey, { state: row.state }))));
      }
      return h(Fragment, null,
        h(DialogHeader, { title: t('distros.title') }),
        h('div', { className: 'drw-body' },
          h('div', { className: 'drw-section' },
            h('span', null, t('distros.section')),
            h('button', {
              type: 'button',
              className: 'drw-icon-button',
              'aria-label': t('distros.refresh'),
              title: t('distros.refresh'),
              disabled: busy || loading,
              onClick: () => {
                loadDistros(t, true);
              },
            }, loading ? h(Spinner, { size: 14 }) : h(RefreshIcon, { size: 14 }))),
          body),
        h(DialogFooter, null,
          h(Button, {
            variant: 'outline',
            disabled: busy,
            onClick: () => {
              flowStore.set({ step: 'source', error: null });
            },
          }, t('action.back')),
          h(Button, { variant: 'outline', disabled: busy, onClick: cancelFlow }, t('action.cancel'))));
    }

    /** Step 3: the Linux (or local-mode) folder browser. */
    function FolderDialog(props) {
      const state = props.state !== null && typeof props.state === 'object' ? props.state : {};
      const t = props.t;
      const busy = props.busy === true;
      const listing = state.listing !== null && typeof state.listing === 'object' ? state.listing : {};
      const data = listing.data !== null && typeof listing.data === 'object' ? listing.data : null;
      const crumbs = crumbsFromListing(data);
      const loading = listing.loading === true;
      const listingError = typeof listing.error === 'string' && listing.error !== '' ? listing.error : null;
      const query = typeof state.search === 'string' ? state.search : '';
      const showHidden = state.showHidden === true;
      const entries = data !== null && Array.isArray(data.entries) ? data.entries : [];
      const visible = showHidden ? entries : entries.filter((entry) => !isHiddenEntry(entry));
      const rows = filterEntries(visible, query);
      const goPath = data !== null ? resolveQueryPath(data, query) : null;
      const canConfirm = data !== null
        && loading !== true
        && listingError === null
        && typeof data.path === 'string'
        && data.path !== ''
        && busy !== true;
      const confirm = () => {
        if (!canConfirm) return;
        void confirmFolder(t);
      };
      const navigate = (path) => {
        if (busy || loading) return;
        if (typeof path !== 'string' || path === '') return;
        loadListing(t, path);
      };

      const crumbNodes = [];
      if (data !== null && typeof data.parent === 'string' && data.parent !== '' && data.parent !== data.path) {
        crumbNodes.push(h('button', {
          key: 'up',
          type: 'button',
          className: 'drw-crumb drw-up',
          'aria-label': t('folder.up'),
          title: t('folder.up'),
          disabled: busy || loading,
          onClick: () => {
            navigate(data.parent);
          },
        }, h(UpIcon, { size: 12 })));
      }
      crumbs.forEach((crumb, index) => {
        const current = index === crumbs.length - 1;
        if (index > 0) crumbNodes.push(h('span', { key: 'sep-' + index, className: 'drw-crumb-sep', 'aria-hidden': true }, '/'));
        crumbNodes.push(h('button', {
          key: 'crumb-' + (crumb.path === '' ? index : crumb.path),
          type: 'button',
          className: 'drw-crumb' + (current ? ' drw-crumb-current' : ''),
          'aria-current': current ? 'page' : undefined,
          title: crumb.path,
          disabled: busy || loading || current,
          onClick: () => {
            navigate(crumb.path);
          },
        }, crumb.name));
      });

      const folderRows = rows.map((entry) => h('button', {
        key: typeof entry.path === 'string' && entry.path !== '' ? entry.path : String(entry.name),
        type: 'button',
        className: 'drw-row drw-row-folder',
        disabled: busy,
        onClick: () => {
          navigate(entry.path);
        },
      },
      h('span', { className: 'drw-row-icon drw-row-icon-plain' }, h(FolderIcon, { size: 16 })),
      h('span', { className: 'drw-row-name' }, entry.name),
      entry.symlink === true ? h('span', { className: 'drw-row-symlink', title: t('folder.symlink'), 'aria-hidden': true }, '\u2197') : null,
      h('span', { className: 'drw-row-chevron', 'aria-hidden': true }, h(ChevronIcon, { size: 12 }))));

      let listBody;
      if (loading) {
        listBody = h('div', { className: 'drw-status', role: 'status' }, t('folder.loading'));
      } else if (listingError !== null) {
        listBody = h('div', { className: 'drw-error', role: 'alert' }, listingError,
          h(Button, { variant: 'outline', disabled: busy, onClick: () => { retryListing(t); } }, t('action.retry')));
      } else {
        listBody = h(Fragment, null,
          goPath !== null ? h('button', {
            type: 'button',
            className: 'drw-row drw-row-go',
            disabled: busy,
            onClick: () => {
              navigate(goPath);
            },
          },
          h('span', { className: 'drw-row-icon drw-row-icon-plain' }, h(GoIcon, { size: 16 })),
          h('span', { className: 'drw-row-name' }, t('folder.goTo', { path: goPath }))) : null,
          folderRows,
          rows.length === 0 && goPath === null ? h('div', { className: 'drw-status' }, t('folder.empty')) : null,
          data !== null && data.truncated === true ? h('div', { className: 'drw-status' }, t('folder.truncated')) : null);
      }

      return h(Fragment, null,
        h(DialogHeader, { title: t('folder.title') }),
        h('div', { className: 'drw-body drw-body-folder' },
          h('div', { className: 'drw-search' },
            h('span', { className: 'drw-search-icon' }, h(SearchIcon, { size: 14 })),
            h('input', {
              className: 'drw-search-input',
              type: 'text',
              value: query,
              spellCheck: false,
              autoComplete: 'off',
              placeholder: t('folder.search'),
              'aria-label': t('folder.search'),
              'data-drw-autofocus': true,
              disabled: busy,
              onChange: (event) => {
                flowStore.set({ search: event.target.value });
              },
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const raw = typeof event.currentTarget.value === 'string' ? event.currentTarget.value.trim() : '';
                if (raw === '') return;
                const current = flowStore.get().listing;
                const live = current !== null && typeof current === 'object' && current.data !== null ? current.data : null;
                // An absolute path needs no listing; `~` resolves through home.
                const target = raw.charAt(0) === '/' ? joinLinuxPath('/', raw) : (live === null ? null : resolveQueryPath(live, raw));
                if (target !== null) loadListing(t, target);
              },
            }),
            h('button', {
              type: 'button',
              className: 'drw-icon-button',
              'aria-label': t('folder.useThis'),
              title: t('folder.useThis'),
              disabled: !canConfirm,
              onClick: confirm,
            }, state.confirming === true ? h(Spinner, { size: 14 }) : h(CheckIcon, { size: 14 }))),
          h('div', { className: 'drw-crumbs' }, crumbNodes),
          h('div', { className: 'drw-toolbar' },
            h('button', {
              type: 'button',
              className: 'drw-toggle',
              'aria-pressed': showHidden,
              disabled: busy,
              onClick: () => {
                flowStore.set({ showHidden: flowStore.get().showHidden !== true });
              },
            }, showHidden ? t('folder.hideHidden') : t('folder.showHidden'))),
          typeof state.error === 'string' && state.error !== '' ? h('div', { className: 'drw-error', role: 'alert' }, state.error) : null,
          h('div', { className: 'drw-list' }, listBody)),
        h(DialogFooter, null,
          h(Button, { variant: 'outline', disabled: busy, onClick: () => { backFromFolder(t); } }, t('action.back')),
          h(Button, { variant: 'outline', disabled: busy, onClick: cancelFlow }, t('action.cancel')),
          h(Button, { variant: 'primary', disabled: !canConfirm, onClick: confirm },
            state.confirming === true
              ? h(Fragment, null, h(Spinner, { size: 12 }), t('folder.connecting'))
              : t('action.confirm'))));
    }

    function pickerUnavailable() {
      const error = new Error('directory-picker/unavailable');
      error.code = 'directory-picker/unavailable';
      return error;
    }

    function resolveUiWorkspace(ctx) {
      try {
        if (ctx.uiWorkspace !== null && ctx.uiWorkspace !== undefined) return ctx.uiWorkspace;
      } catch (error) {
        /* fall through to the registry */
      }
      try {
        const service = ctx.get('uiWorkspace');
        return service === undefined ? null : service;
      } catch (error) {
        return null;
      }
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------

    /**
     * Client plugin body.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-wsl: dictionaries');

      ctx.effect(() => {
        if (typeof document === 'undefined' || !document.head) return undefined;
        if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return undefined;
        const tag = document.createElement('style');
        tag.setAttribute('data-plugin-css', STYLE_ID);
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          if (tag.parentNode !== null && tag.parentNode !== undefined) tag.parentNode.removeChild(tag);
        };
      }, 'dsh-remote-wsl: dialog styles');

      workspaceService = resolveUiWorkspace(ctx);
      ctx.effect(() => () => {
        workspaceService = null;
      }, 'dsh-remote-wsl: service release');

      const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
      pickNativeImpl = desktop !== undefined && desktop !== null && typeof desktop.pick === 'function'
        ? () => desktop.pick()
        : () => {
          const service = workspaceService;
          if (service === null || typeof service.pickDirectory !== 'function') return Promise.reject(pickerUnavailable());
          return service.pickDirectory();
        };

      const injectedFlow = () => ({ store: flowStore, pickNative: () => pickNativeImpl() });
      for (const hole of HOLES) {
        ctx.slots.inject(hole, () => ctx.slots.register({
          name: hole,
          priority: -100,
          locale: NS,
          inject: injectedFlow,
        }, FlowBridge));
      }

      ctx.slots.inject(OVERLAY, () => ctx.slots.register({
        name: OVERLAY,
        id: 'dsh-remote-wsl.flow',
        order: 5,
        locale: NS,
        inject: () => ({ store: flowStore }),
      }, FlowOverlay));
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'workspaces'],
      apply,
      __test: {
        mapDistroStatus,
        filterEntries,
        crumbsFromListing,
        formatConnectError,
        joinLinuxPath,
        resolveQueryPath,
        isHiddenEntry,
        isPickerUnavailable,
        failureText,
        createStore,
      },
    };
  },
});
