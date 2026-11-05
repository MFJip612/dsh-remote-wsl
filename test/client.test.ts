/** Browser entry regression checks run without a DOM, React installation or Desktop. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8');
const tests: { name: string; run: () => unknown }[] = [];
const test = (name: string, run: () => unknown) => tests.push({ name, run });
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
type BrowserDefinition = { id: string; factory(require: (name: string) => unknown): ClientPlugin };

function loadClient() {
  let plugin: ClientPlugin | undefined;
  const failures: unknown[][] = [];
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(definition: BrowserDefinition) {
          assert.equal(definition.id, 'dsh-remote-wsl');
          plugin = definition.factory((name) => {
            assert.ok(name === 'react' || name === 'react-dom');
            return {};
          });
        },
      },
    },
    console: { error: (...args: unknown[]) => failures.push(args) },
  });
  assert.ok(plugin);
  return { plugin, helpers: plugin.__test, failures };
}

test('distro rows preserve host states, trim names and skip invalid rows', () => {
  const { helpers } = loadClient();
  assert.deepEqual(plain(helpers.mapDistroStatus([
    null, {}, { name: ' ' },
    { name: ' Ubuntu ', running: true, isDefault: true },
    { name: 'Debian', status: 'stopped' },
    { name: 'Installing', status: 'other', state: 'Installing, 20%' },
  ])), [
    { name: 'Ubuntu', isDefault: true, status: 'running', statusKey: 'distro.status.connected', state: 'running' },
    { name: 'Debian', isDefault: false, status: 'stopped', statusKey: 'distro.status.stopped', state: 'stopped' },
    { name: 'Installing', isDefault: false, status: 'other', statusKey: 'distro.status.installing', state: 'Installing, 20%' },
  ]);
  assert.deepEqual(plain(helpers.mapDistroStatus(null)), []);
});

test('folder filtering keeps path jumps and recognizes hidden directories', () => {
  const { helpers } = loadClient();
  const entries = [{ name: 'Projects', path: '/Projects' }, { name: '.git', path: '/.git' }];
  assert.deepEqual(plain(helpers.filterEntries(entries, 'PROJECT')), [entries[0]]);
  for (const query of ['', '/etc', '~/work']) {
    assert.deepEqual(plain(helpers.filterEntries(entries, query)), entries);
  }
  assert.equal(helpers.isHiddenEntry(entries[1]), true);
  assert.equal(helpers.isHiddenEntry({ name: 'cache', hidden: true }), true);
  assert.equal(helpers.isHiddenEntry(null), false);
});

test('breadcrumbs collapse duplicate host roots and preserve fallback paths', () => {
  const { helpers } = loadClient();
  assert.deepEqual(plain(helpers.crumbsFromListing({ crumbs: [
    null, { name: 'Ubuntu', path: '/' }, { name: 'duplicate', path: '/' },
    { name: 'home', path: '/home' },
  ] })), [{ name: 'Ubuntu', path: '/' }, { name: 'home', path: '/home' }]);
  assert.deepEqual(plain(helpers.crumbsFromListing({ distro: ' Ubuntu ', path: '/home/me' })), [
    { name: 'Ubuntu', path: '/' }, { name: '/home/me', path: '/home/me' },
  ]);
});

test('Linux jump paths normalize parent segments and expand the listing home', () => {
  const { helpers } = loadClient();
  assert.equal(helpers.joinLinuxPath('/home/me', '../work/./src'), '/home/work/src');
  assert.equal(helpers.resolveQueryPath({ home: '/home/me' }, '~/work'), '/home/me/work');
  assert.equal(helpers.resolveQueryPath(null, '/usr/../etc'), '/etc');
  assert.equal(helpers.resolveQueryPath({ home: '/home/me' }, 'work'), null);
});

test('picker fallback and error messages survive nested RPC and Error wrappers', () => {
  const { helpers } = loadClient();
  assert.equal(helpers.isPickerUnavailable(new Error('directory picker failed: needs the native capability')), true);
  assert.equal(helpers.isPickerUnavailable({ cause: { rpcError: { code: 'directory-picker/unavailable' } } }), true);
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.equal(helpers.isPickerUnavailable(cycle), false);
  assert.equal(helpers.failureText({ rpcError: { message: 'Permission denied' } }), 'Permission denied');
  assert.equal(helpers.failureText(new Error('Disconnected')), 'Disconnected');
  assert.equal(helpers.formatConnectError({ error: { message: 'Host refusal' } }, (key) => key), 'Host refusal');
  assert.equal(helpers.formatConnectError(null, (key) => `translated:${key}`), 'translated:error.generic');
});

test('store merges patches, isolates failing subscribers and unsubscribes', () => {
  const { helpers, failures } = loadClient();
  const store = helpers.createStore({ count: 0, keep: true });
  let notified = 0;
  const stopThrowing = store.subscribe(() => { throw new Error('listener failed'); });
  const unsubscribe = store.subscribe(() => { notified += 1; });
  store.set({ count: 1 });
  assert.deepEqual(plain(store.get()), { count: 1, keep: true });
  assert.equal(notified, 1);
  assert.equal(failures.length, 1);
  stopThrowing();
  unsubscribe();
  store.set({ count: 2 });
  assert.equal(notified, 1);
  assert.equal(failures.length, 1);
});

test('apply registers both directory holes and overlay, then releases owned resources', async () => {
  const { plugin } = loadClient();
  const slots: { options: ClientSlotDescriptor<unknown>; componentName: string }[] = [];
  const disposers: ClientDisposer[] = [];
  const disposed: string[] = [];
  const locales: { namespace: string; dictionaries: Record<string, Record<string, string>> }[] = [];
  plugin.apply({
    get: () => undefined,
    uiWorkspace: { pickDirectory: () => Promise.resolve('/native/project') },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    locale: {
      register(namespace, dictionaries) {
        locales.push({ namespace, dictionaries });
        return () => disposed.push('locale');
      },
    },
    slots: {
      inject(name, factory) {
        const dispose = factory();
        if (typeof dispose === 'function') disposers.push(dispose);
      },
      register(options, component) {
        const componentName: unknown = Reflect.get(component, 'name');
        assert.equal(typeof componentName, 'string');
        slots.push({ options, componentName: String(componentName) });
        return () => disposed.push(options.name);
      },
    },
  });
  assert.deepEqual(plain(plugin.inject), ['slots', 'locale', 'uiWorkspace', 'workspaces']);
  const locale = locales[0];
  assert.ok(locale);
  assert.equal(locale.namespace, 'dshRemoteWsl');
  assert.deepEqual(Object.keys(locale.dictionaries), ['zh', 'en']);
  assert.deepEqual(slots.map(({ options, componentName }) => [options.name, componentName]), [
    ['sidebar.workspaces.directoryFlow', 'FlowBridge'],
    ['conversation.hero.workspace.directoryFlow', 'FlowBridge'],
    ['shell.overlay', 'FlowOverlay'],
  ]);
  for (const { options } of slots.slice(0, 2)) {
    assert.equal(options.priority, -100);
    assert.equal(options.locale, 'dshRemoteWsl');
  }
  assert.equal(slots[2].options.id, 'dsh-remote-wsl.flow');
  assert.equal(slots[2].options.order, 5);
  const directory = flowInjection(slots[0].options.inject());
  assert.equal(directory.store, flowStore(slots[1].options.inject()));
  assert.equal(directory.store, flowStore(slots[2].options.inject()));
  assert.equal(await directory.pickNative(), '/native/project');
  disposers.reverse().forEach((dispose) => dispose());
  assert.deepEqual(disposed, [
    'shell.overlay', 'conversation.hero.workspace.directoryFlow',
    'sidebar.workspaces.directoryFlow', 'locale',
  ]);
  await assert.rejects(directory.pickNative(), { code: 'directory-picker/unavailable' });
});

function flowInjection(value: unknown): { store: unknown; pickNative: () => Promise<unknown> } {
  assert.ok(typeof value === 'object' && value !== null && 'store' in value && 'pickNative' in value);
  assert.equal(typeof value.pickNative, 'function');
  // Slot injection is a VM boundary; validate the members consumed by this test.
  return value as { store: unknown; pickNative: () => Promise<unknown> };
}

function flowStore(value: unknown): unknown {
  assert.ok(typeof value === 'object' && value !== null && 'store' in value);
  return value.store;
}

let failed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`, error);
  }
}
console.log(`PASS ${tests.length - failed} FAIL ${failed}`);
if (failed) process.exitCode = 1;
