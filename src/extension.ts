import * as os from 'os';
import * as vscode from 'vscode';
import { ClaudeCliClient } from './backend/ClaudeCliClient';
import { EventStore } from './backend/EventStore';
import { discoverHistoricalProjects } from './backend/HistoricalProjects';
import { HistoricalSessionScanner } from './backend/HistoricalSessions';
import { HistoryImporter } from './backend/HistoryImporter';
import { ClaudeArchiveMarkerReader, stateDbPathFromGlobalStorage } from './backend/ClaudeArchiveMarker';
import { DEFAULT_RECENT_DAYS } from './backend/historyTiers';
import { DEFAULT_POLL_SECONDS, DemoMode, SessionManager, SessionManagerConfig } from './backend/SessionManager';
import { WorkspaceImporter } from './backend/WorkspaceImporter';
import { WorkspaceRegistry } from './backend/WorkspaceRegistry';
import { CityState } from './models/CityState';
import { HookService } from './services/HookService';
import { SessionOpener } from './services/SessionOpener';
import { StateSynchronizer } from './services/StateSynchronizer';
import { WorkspaceActions } from './services/WorkspaceActions';
import { WebviewToExtensionMessage } from './shared/protocol';
import { CityPanel } from './views/CityPanel';
import { CitySidebarProvider } from './views/CitySidebarProvider';
import { StatusBarController } from './views/StatusBarController';

const SECTION = 'claudeCity';

interface ExtensionConfig extends SessionManagerConfig {
  claudePath: string;
  discoverHistoricalProjects: boolean;
  historyImport: boolean;
  historyMaxAgeDays: number;
  historyRecentDays: number;
  historyUseClaudeArchive: boolean;
}

function numberSetting(v: unknown, fallback: number, min: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : fallback;
}

function readConfig(): ExtensionConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  const demo = c.get<string>('demoMode', 'auto');
  return {
    pollIntervalSeconds: c.get<number>('pollIntervalSeconds', DEFAULT_POLL_SECONDS),
    demoMode: (demo === 'on' || demo === 'off' ? demo : 'auto') as DemoMode,
    dayNight: c.get<boolean>('ambient.dayNight', true) !== false,
    claudePath: c.get<string>('claudePath', '') ?? '',
    discoverHistoricalProjects: c.get<boolean>('discoverHistoricalProjects', true) !== false,
    historyImport: c.get<boolean>('history.importSessions', true) !== false,
    historyMaxAgeDays: numberSetting(c.get<number>('history.maxAgeDays', 90), 90, 1),
    historyMaxPerWorkspace: Math.floor(numberSetting(c.get<number>('history.maxSessionsPerWorkspace', 12), 12, 0)),
    historyMaxRecentPerWorkspace: Math.floor(numberSetting(c.get<number>('history.maxRecentPerWorkspace', 20), 20, 0)),
    historyRecentDays: numberSetting(c.get<number>('history.recentDays', DEFAULT_RECENT_DAYS), DEFAULT_RECENT_DAYS, 0),
    historyUseClaudeArchive: c.get<boolean>('history.useClaudeCodeArchive', true) !== false,
  };
}

/** claudeCity.workspaceRoots (application scope: only user settings can configure scanned folders). */
function readRoots(): string[] {
  const v = vscode.workspace.getConfiguration(SECTION).get<unknown>('workspaceRoots', []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

async function writeRoots(roots: string[]): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('workspaceRoots', roots, vscode.ConfigurationTarget.Global);
}

function openFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}

export interface ClaudeCityApi {
  getState(): CityState;
}

let registryForDeactivate: WorkspaceRegistry | undefined;
let hooksForDeactivate: HookService | undefined;

export function activate(context: vscode.ExtensionContext): ClaudeCityApi {
  const output = vscode.window.createOutputChannel('Claude City', { log: true });
  const log = (msg: string) => output.info(msg);

  const registry = new WorkspaceRegistry(context.globalState, { homeDir: os.homedir() });
  registryForDeactivate = registry;
  registry.setOpenFolders(openFolderPaths());

  const client = new ClaudeCliClient({ getOverride: () => readConfig().claudePath });
  const events = new EventStore(500);
  const manager = new SessionManager({ client, registry, events, getConfig: readConfig });
  const sync = new StateSynchronizer(() => manager.state);
  const statusBar = new StatusBarController();
  const opener = new SessionOpener(registry, () => manager.state, log);
  const historyScanner = new HistoricalSessionScanner({ memento: context.globalState });
  const archiveMarker = new ClaudeArchiveMarkerReader(stateDbPathFromGlobalStorage(context.globalStorageUri?.fsPath));
  const importer = new WorkspaceImporter({
    registry,
    getRoots: readRoots,
    setRoots: writeRoots,
    homeDir: os.homedir(),
    warn: (msg) => void vscode.window.showWarningMessage(msg),
    log,
    onChanged: () => {
      manager.regroupHistory();
      void manager.refresh();
    },
  });
  const workspaceActions = new WorkspaceActions({
    registry,
    importer,
    getRoots: readRoots,
    log,
    afterChange: ({ fit }) => {
      manager.regroupHistory();
      void manager.refresh();
      if (fit) sync.requestFit();
    },
  });
  const history = new HistoryImporter({
    scanner: historyScanner,
    getConfig: () => {
      const cfg = readConfig();
      return {
        enabled: cfg.historyImport,
        maxAgeDays: cfg.historyMaxAgeDays,
        recentDays: cfg.historyRecentDays,
        useClaudeArchive: cfg.historyUseClaudeArchive,
      };
    },
    // Best effort: Claude Code's own "archived" session ids (read-only, see ClaudeArchiveMarker.ts).
    readArchiveMarker: () => archiveMarker.read(),
    onSessions: (sessions) => manager.setHistorySessions(sessions),
    log, // aggregate counts only
    // Workspace roots are rescanned on the same (120 s) cadence, before archived sessions are grouped.
    beforeScan: () => importer.rescan(),
  });
  const hooks = new HookService({
    context,
    log,
    debug: (msg) => output.debug(msg),
    onEvents: (evts) => manager.ingestHookEvents(evts),
    onStatus: (status) => manager.setHookStatus(status),
  });
  hooksForDeactivate = hooks;

  const report = (what: string) => (e: unknown) => log(`${what} failed: ${(e as Error)?.message ?? String(e)}`);

  const onMessage = (msg: WebviewToExtensionMessage) => {
    switch (msg.type) {
      case 'openCity':
        vscode.commands.executeCommand('claudeCity.open').then(undefined, report('open'));
        break;
      case 'refresh':
        void manager.refresh();
        void history.refresh();
        void hooks.refreshInstallState();
        break;
      case 'toggleDemo':
        manager.toggleDemo();
        break;
      case 'openFolder':
        opener.openWorkspace(msg.workspaceId, true).catch(report('openWorkspace'));
        break;
      case 'openWorkspace':
        opener.openWorkspace(msg.workspaceId, msg.newWindow).catch(report('openWorkspace'));
        break;
      case 'openSession':
        opener.openSession(msg.sessionId).catch(report('openSession'));
        break;
      case 'copySessionId':
        opener.copySessionId(msg.sessionId).catch(report('copySessionId'));
        break;
      case 'installHooks':
        hooks.installHooks().catch(report('installHooks'));
        break;
      case 'uninstallHooks':
        hooks.uninstallHooks().catch(report('uninstallHooks'));
        break;
      case 'importWorkspaces':
        workspaceActions.importFromFolder().catch(report('importWorkspaces'));
        break;
      case 'removeWorkspace':
        workspaceActions.removeWorkspace(msg.workspaceId).catch(report('removeWorkspace'));
        break;
      case 'setWorkspacePinned':
        workspaceActions.setPinned(msg.workspaceId, msg.pinned).catch(report('setWorkspacePinned'));
        break;
      case 'ready':
        break; // handled by webviewHost
    }
  };

  const updateVisibility = () => manager.setViewsVisible(panel.isVisible || sidebar.isVisible);
  const hostDeps = { extensionUri: context.extensionUri, sync, onMessage, log };
  const panel = new CityPanel(hostDeps, () => updateVisibility());
  const sidebar = new CitySidebarProvider(hostDeps, () => updateVisibility());

  let lastSource: string | undefined;
  context.subscriptions.push(
    output,
    manager,
    history,
    sync,
    statusBar,
    panel,
    sidebar,
    hooks,
    manager.onDidChangeState((state) => {
      statusBar.update(state);
      sync.pushState();
      if (state.source !== lastSource) {
        lastSource = state.source;
        log(`data source: ${state.source}${state.error ? ` (${state.error})` : ''}${state.cliVersion ? ` claude ${state.cliVersion}` : ''}`);
      }
    }),
    // Events (hook + diff) go to the webviews immediately; state snapshots stay throttled.
    manager.onDidAddEvents((evts) => sync.pushEvents(evts)),
    vscode.window.registerWebviewViewProvider(CitySidebarProvider.viewId, sidebar),
    vscode.commands.registerCommand('claudeCity.open', () => panel.show()),
    vscode.commands.registerCommand('claudeCity.refresh', () => {
      void hooks.refreshInstallState();
      void history.refresh();
      return manager.refresh();
    }),
    vscode.commands.registerCommand('claudeCity.toggleDemoData', () => manager.toggleDemo()),
    vscode.commands.registerCommand('claudeCity.installHooks', () => hooks.installHooks()),
    vscode.commands.registerCommand('claudeCity.uninstallHooks', () => hooks.uninstallHooks()),
    vscode.commands.registerCommand('claudeCity.importWorkspacesFromFolder', () => workspaceActions.importFromFolder()),
    vscode.commands.registerCommand('claudeCity.removeWorkspaceRoot', () => workspaceActions.removeRoot()),
    vscode.commands.registerCommand('claudeCity.removeWorkspace', (id?: unknown) => workspaceActions.removeWorkspace(id)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      registry.setOpenFolders(openFolderPaths());
      void manager.refresh();
      void hooks.refreshInstallState();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      hooks.onConfigurationChanged(e);
      if (e.affectsConfiguration(`${SECTION}.claudePath`)) client.invalidate();
      if (e.affectsConfiguration(`${SECTION}.demoMode`)) {
        manager.setDemoOverride(undefined); // setting wins over the runtime toggle
        return;
      }
      if (e.affectsConfiguration(`${SECTION}.ambient`)) {
        manager.republish();
        return;
      }
      if (e.affectsConfiguration(`${SECTION}.hookBridge`)) return;
      if (e.affectsConfiguration(`${SECTION}.workspaceRoots`)) {
        void importer.rescan();
        return;
      }
      if (
        e.affectsConfiguration(`${SECTION}.history.maxSessionsPerWorkspace`) ||
        e.affectsConfiguration(`${SECTION}.history.maxRecentPerWorkspace`)
      ) {
        manager.republish();
      }
      if (
        e.affectsConfiguration(`${SECTION}.history.importSessions`) ||
        e.affectsConfiguration(`${SECTION}.history.maxAgeDays`) ||
        e.affectsConfiguration(`${SECTION}.history.recentDays`) ||
        e.affectsConfiguration(`${SECTION}.history.useClaudeCodeArchive`)
      ) {
        void history.refresh();
        return;
      }
      if (e.affectsConfiguration(`${SECTION}.history`)) return;
      if (e.affectsConfiguration(`${SECTION}.discoverHistoricalProjects`)) void runDiscovery();
      void manager.refresh();
    }),
  );

  const runDiscovery = async () => {
    if (!readConfig().discoverHistoricalProjects) {
      registry.setHistoricalProjects([]);
      return;
    }
    try {
      const paths = await discoverHistoricalProjects();
      registry.setHistoricalProjects(paths);
      log(`discovered ${paths.length} historical project(s)`);
      void manager.refresh();
    } catch (err) {
      log(`historical project discovery failed: ${(err as Error)?.message ?? String(err)}`);
    }
  };

  manager.start();
  void hooks.start();
  void runDiscovery();
  // Past sessions: scanned after the first live poll (never blocks activation), then every 120 s.
  history.start(manager.firstPoll);
  log('Claude City activated');

  return { getState: () => manager.state };
}

export async function deactivate(): Promise<void> {
  // Subscriptions (timers, listeners, webviews) are disposed by VS Code. Persist the registry and wait
  // until the hook server has released its port (a new window may want to bind it right away).
  const r = registryForDeactivate;
  const h = hooksForDeactivate;
  registryForDeactivate = undefined;
  hooksForDeactivate = undefined;
  await Promise.all([r?.flush(), h?.stopAsync()]);
}
