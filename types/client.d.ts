/** Browser ports are supplied by the DSH module loader; React is never bundled. */
type ClientReactNode = import('react').ReactNode;
type ClientTranslate = (key: string, values?: Record<string, string>) => string;
type ClientDisposer = () => void;
interface ClientStore<S> {
  get(): S;
  set(patch: Partial<S>): void;
  subscribe(listener: () => void): ClientDisposer;
}
interface ClientHandlers {
  onPicked?: (path: string) => void;
  onCancel?: () => void;
  onError?: (message: string) => void;
}
interface ClientFlowStore extends ClientStore<ClientFlowState> {
  begin(source: ClientHandlers | (() => ClientHandlers) | null): void;
  clear(): void;
  handlers(): ClientHandlers;
}
interface ClientCrumb { name: string; path: string }
interface ClientDirectoryEntry extends ClientCrumb { hidden?: boolean; symlink?: boolean }
interface ClientListing {
  distro?: string;
  path?: string;
  home?: string;
  parent?: string | null;
  crumbs?: ClientCrumb[];
  entries?: ClientDirectoryEntry[];
  truncated?: boolean;
}
interface ClientDistroRow {
  name: string;
  isDefault: boolean;
  status: 'running' | 'stopped' | 'other';
  statusKey: 'distro.status.connected' | 'distro.status.stopped' | 'distro.status.installing';
  state: string;
}
interface ClientDistroPayload { distros?: unknown[]; defaultDistro?: string }
interface ClientConnectRequest { distro: string; linuxPath: string }
interface ClientDataBox<T> { loading: boolean; error: string | null; data: T | null }
interface ClientStatus {
  loading: boolean;
  available: boolean | null;
  error: string | null;
  platform?: string;
  defaultDistro?: string | null;
}
interface ClientFlowState {
  active: boolean;
  step: 'source' | 'distros' | 'folder';
  mode: 'local' | 'wsl';
  distro: string | null;
  status: ClientStatus | null;
  distros: ClientDataBox<ClientDistroPayload> | null;
  listing: ClientDataBox<ClientListing> | null;
  requestedPath: string | null;
  search: string;
  showHidden: boolean;
  confirming: boolean;
  nativeBusy: boolean;
  ownerBusy: boolean;
  error: string | null;
}
interface ClientWorkspacePort {
  listDirectory?: (path?: string, signal?: AbortSignal) => unknown | Promise<unknown>;
  pickDirectory?: () => unknown | Promise<unknown>;
}
interface ClientFlowProps extends ClientHandlers {
  store?: ClientFlowStore;
  open?: boolean;
  busy?: boolean;
  t?: ClientTranslate;
  pickNative?: () => unknown | Promise<unknown>;
}
interface ClientDialogProps { state: ClientFlowState; t: ClientTranslate; busy: boolean }
interface ClientFlowRootProps { state: ClientFlowState; t: ClientTranslate; store: ClientFlowStore }
interface ClientButtonProps {
  children?: ClientReactNode;
  variant?: 'primary' | 'outline';
  disabled?: boolean;
  onClick?: import('react').MouseEventHandler<HTMLButtonElement>;
  ariaLabel?: string;
}
interface ClientSlotDescriptor<P> {
  name: string;
  id?: string;
  priority?: number;
  order?: number;
  locale: string;
  inject(): P;
}
interface ClientContext {
  effect(factory: () => void | ClientDisposer, label?: string): void;
  uiWorkspace?: ClientWorkspacePort | null;
  get(name: 'uiWorkspace'): ClientWorkspacePort | undefined;
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): ClientDisposer };
  slots: {
    inject(name: string, factory: () => ClientDisposer): void;
    register<P>(descriptor: ClientSlotDescriptor<P>, component: import('react').ComponentType<P>): ClientDisposer;
  };
}
interface ClientRequire {
  (name: 'react'): typeof import('react');
  (name: 'react-dom'): typeof import('react-dom');
}
interface ClientHelpers {
  mapDistroStatus(distros: unknown): ClientDistroRow[];
  filterEntries<T>(entries: T[], query: unknown): T[];
  filterEntries(entries: unknown, query: unknown): unknown[];
  crumbsFromListing(listing: unknown): ClientCrumb[];
  formatConnectError(payload: unknown, t?: ClientTranslate): string;
  joinLinuxPath(base: unknown, rel: unknown): string;
  resolveQueryPath(listing: unknown, query: unknown): string | null;
  isHiddenEntry(entry: unknown): boolean;
  isPickerUnavailable(error: unknown): boolean;
  failureText(error: unknown): string;
  createStore<S extends object>(initial: S): ClientStore<S>;
}
interface ClientPlugin { inject: string[]; apply(ctx: ClientContext): void; __test: ClientHelpers }
interface Window {
  __ModuleLoader__: { load(definition: { id: string; factory(require: ClientRequire): ClientPlugin }): void };
}
declare var __DSH_DIRECTORY_PICKER__: { pick(): unknown | Promise<unknown> } | undefined;
