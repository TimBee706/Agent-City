import * as os from 'os';
import * as vscode from 'vscode';
import { DEFAULT_HOOK_PORT, HookBridge, HookBridgeInfo, HttpHookBridge, NoopHookBridge } from '../backend/HookBridge';
import {
  HookSpec,
  InstallState,
  fileInstallState,
  installHooksInFile,
  uninstallHooksFromFile,
  userSettingsPath,
  workspaceSettingsPath,
} from '../backend/HookInstaller';
import { HOOK_TOKEN_SECRET_KEY, HookTokenStore } from '../backend/HookToken';
import { ensureGitExcluded } from '../backend/gitExclude';
import { AgentEvent } from '../models/AgentEvent';
import { HookInstallState, HookStatus } from '../models/CityState';

const SECTION = 'claudeCity.hookBridge';
const TOKEN_FILE = 'hook-token';

export interface HookServiceDeps {
  context: vscode.ExtensionContext;
  log: (msg: string) => void;
  /** Debug-level log (e.g. request header names); defaults to no-op. */
  debug?: (msg: string) => void;
  onEvents: (events: AgentEvent[]) => void;
  onStatus: (status: HookStatus) => void;
}

interface BridgeConfig {
  enabled: boolean;
  port: number;
}

function readBridgeConfig(): BridgeConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  const port = Number(c.get<number>('port', DEFAULT_HOOK_PORT));
  return {
    enabled: c.get<boolean>('enabled', true) !== false,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_HOOK_PORT,
  };
}

/**
 * Owns the hook bridge (HTTP server), the shared secret and the settings.json installer UI.
 *
 * Token decision: Claude Code http hooks support `$VAR` interpolation in headers only for variables
 * listed in `allowedEnvVars` AND present in the environment of the Claude process. Claude runs in
 * arbitrary terminals/hosts where we cannot inject env vars, so the token is written as a fixed header
 * value into the chosen settings file (user-only file in the home directory). Trade-off: anyone who can
 * read that file can post fake events to the city - the token only protects the loopback port against
 * other local processes / web pages, it guards no other capability (the bridge never returns decisions).
 */
export class HookService implements vscode.Disposable {
  private bridge: HookBridge = new NoopHookBridge();
  private bridgeSubs: vscode.Disposable[] = [];
  /** Token the running bridge was started with. */
  private bridgeToken: string | undefined;
  private readonly tokens: HookTokenStore;
  private readonly secretsSub: vscode.Disposable;
  private config: BridgeConfig = readBridgeConfig();
  private install: HookInstallState = 'unknown';
  private disposed = false;
  private restartChain: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | undefined;

  constructor(private readonly deps: HookServiceDeps) {
    const { secrets, globalStorageUri } = deps.context;
    this.tokens = new HookTokenStore({
      secrets,
      fallbackFile: vscode.Uri.joinPath(globalStorageUri, TOKEN_FILE).fsPath,
      log: deps.log,
    });
    // Another window (sharing SecretStorage) may have replaced the token.
    this.secretsSub = secrets.onDidChange((e) => {
      if (e.key === HOOK_TOKEN_SECRET_KEY) void this.onTokenChanged();
    });
  }

  private async onTokenChanged(): Promise<void> {
    if (this.disposed) return;
    // Let an in-flight (re)start finish first: its own secrets.store() also triggers this event.
    await this.restartChain;
    if (this.disposed) return;
    this.tokens.invalidate();
    try {
      const token = await this.tokens.get();
      if (this.disposed) return;
      if (this.config.enabled && token !== this.bridgeToken) {
        this.deps.log('hook token changed in SecretStorage - restarting the hook bridge');
        await this.start(); // restart() also refreshes the install state
      } else {
        await this.refreshInstallState();
      }
    } catch (err) {
      this.deps.log(`hook token reload failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  get status(): HookStatus {
    const info: HookBridgeInfo = this.bridge.info;
    const s: HookStatus = { bridge: info.status, install: this.install, port: this.config.port };
    if (info.error) s.error = info.error;
    return s;
  }

  private emitStatus(): void {
    if (!this.disposed) this.deps.onStatus(this.status);
  }

  /** Starts (or restarts) the bridge according to the settings. Never rejects. */
  start(): Promise<void> {
    this.restartChain = this.restartChain.then(() => this.restart()).catch((err) => {
      this.deps.log(`hook bridge start failed: ${(err as Error)?.message ?? String(err)}`);
    });
    return this.restartChain;
  }

  onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void {
    if (!e.affectsConfiguration(SECTION)) return;
    void this.start();
  }

  private async restart(): Promise<void> {
    if (this.disposed) return;
    this.config = readBridgeConfig();
    await this.stopBridge();
    if (this.disposed) return;
    if (this.config.enabled) {
      const token = await this.tokens.get();
      if (this.disposed) return;
      const bridge = new HttpHookBridge({ port: this.config.port, token, log: this.deps.log, debug: this.deps.debug });
      this.bridge = bridge;
      this.bridgeToken = token;
      this.bridgeSubs = [
        bridge.onEvent((evts) => this.deps.onEvents(evts)),
        bridge.onDidChangeStatus(() => this.emitStatus()),
      ];
      await bridge.start();
    } else {
      this.bridge = new NoopHookBridge();
      this.bridgeToken = undefined;
    }
    await this.refreshInstallState();
  }

  private async stopBridge(): Promise<void> {
    for (const d of this.bridgeSubs) d.dispose();
    this.bridgeSubs = [];
    const old = this.bridge;
    this.bridge = new NoopHookBridge();
    await old.stop();
    old.dispose();
  }

  private async spec(): Promise<HookSpec> {
    return { port: this.config.port, token: await this.tokens.get() };
  }

  private candidateFiles(): { label: string; description: string; file: string }[] {
    const out = [{ label: 'User settings', description: userSettingsPath(os.homedir()), file: userSettingsPath(os.homedir()) }];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') continue;
      const file = workspaceSettingsPath(f.uri.fsPath);
      out.push({ label: `Workspace: ${f.name} (settings.local.json, kept out of git)`, description: file, file });
    }
    return out;
  }

  /** Checks the user file and the open workspaces' settings.local.json for our hooks. */
  async refreshInstallState(): Promise<HookInstallState> {
    try {
      const spec = await this.spec();
      const states: InstallState[] = await Promise.all(this.candidateFiles().map((c) => fileInstallState(c.file, spec)));
      this.install = states.includes('current') ? 'current' : states.includes('outdated') ? 'outdated' : 'none';
    } catch (err) {
      this.deps.log(`hook install state check failed: ${(err as Error)?.message ?? String(err)}`);
      this.install = 'unknown';
    }
    this.emitStatus();
    return this.install;
  }

  async installHooks(): Promise<void> {
    const candidates = this.candidateFiles();
    const pick =
      candidates.length === 1
        ? candidates[0]
        : await vscode.window.showQuickPick(candidates, {
            title: 'Install Claude City hooks into…',
            placeHolder: 'User settings apply to every Claude Code session on this machine (recommended)',
          });
    if (!pick) return;
    const spec = await this.spec();
    const confirm = await vscode.window.showWarningMessage(
      'Install Claude City hooks?',
      {
        modal: true,
        detail:
          `File: ${pick.file}\n\n` +
          `Claude City appends http hooks (SessionEnd, SubagentStart/Stop, TaskCreated/Completed, Stop, ` +
          `StopFailure, Notification, TeammateIdle) that POST event JSON to http://127.0.0.1:${spec.port}/claude-city/hook ` +
          `with a secret token header. Existing hooks are kept untouched; a backup of the file is written first. ` +
          `Hooks never block Claude: if VS Code is closed, the request simply fails.`,
      },
      'Install',
    );
    if (confirm !== 'Install') return;
    const result = await installHooksInFile(pick.file, spec);
    if (result.kind !== 'error' && pick.file !== userSettingsPath(os.homedir())) await this.keepOutOfGit(pick.file);
    switch (result.kind) {
      case 'unchanged':
        void vscode.window.showInformationMessage('Claude City hooks are already installed and up to date.');
        break;
      case 'written':
        this.deps.log(`hooks installed in ${pick.file}${result.backupPath ? ` (backup: ${result.backupPath})` : ''}`);
        void vscode.window.showInformationMessage(
          `Claude City hooks installed in ${pick.file}. New Claude Code sessions send live events` +
            `${result.backupPath ? `; backup: ${result.backupPath}` : ''}.`,
        );
        break;
      case 'error':
        this.deps.log(`hook install failed: ${result.error}`);
        void vscode.window.showErrorMessage(`Claude City: hooks not installed - ${result.error}`);
        break;
    }
    await this.refreshInstallState();
  }

  /** The workspace file contains the token: make sure git never picks it up (best effort). */
  private async keepOutOfGit(file: string): Promise<void> {
    const r = await ensureGitExcluded(file);
    switch (r.kind) {
      case 'added':
        this.deps.log(`added ${r.pattern} to ${r.excludeFile}`);
        break;
      case 'error':
        this.deps.log(`could not add ${file} to git's info/exclude: ${r.error}`);
        void vscode.window.showWarningMessage(
          `Claude City: could not add ${file} to the repository's .git/info/exclude (${r.error}). ` +
            'It contains the hook token - make sure it is not committed.',
        );
        break;
      default:
        break; // already excluded, or not inside a git repository
    }
  }

  async uninstallHooks(): Promise<void> {
    const spec = await this.spec();
    const candidates = [];
    for (const c of this.candidateFiles()) {
      if ((await fileInstallState(c.file, spec)) !== 'none') candidates.push(c);
    }
    if (!candidates.length) {
      void vscode.window.showInformationMessage('No Claude City hooks found in user or workspace Claude settings.');
      await this.refreshInstallState();
      return;
    }
    const pick =
      candidates.length === 1
        ? candidates[0]
        : await vscode.window.showQuickPick(candidates, { title: 'Remove Claude City hooks from…' });
    if (!pick) return;
    const confirm = await vscode.window.showWarningMessage(
      'Remove Claude City hooks?',
      {
        modal: true,
        detail: `File: ${pick.file}\n\nOnly Claude City's own hook entries are removed; all other settings and hooks stay unchanged. A backup is written first.`,
      },
      'Remove',
    );
    if (confirm !== 'Remove') return;
    const result = await uninstallHooksFromFile(pick.file);
    if (result.kind === 'error') {
      void vscode.window.showErrorMessage(`Claude City: hooks not removed - ${result.error}`);
    } else {
      void vscode.window.showInformationMessage(
        result.kind === 'written' ? `Claude City hooks removed from ${pick.file}.` : 'Nothing to remove.',
      );
    }
    await this.refreshInstallState();
  }

  /** Stops the bridge and waits until the port is released (used by deactivate). Never rejects. */
  stopAsync(): Promise<void> {
    this.disposed = true;
    this.secretsSub.dispose();
    this.stopping ??= this.restartChain
      .catch(() => undefined)
      .then(() => this.stopBridge())
      .catch((err) => this.deps.log(`hook bridge stop failed: ${(err as Error)?.message ?? String(err)}`));
    return this.stopping;
  }

  dispose(): void {
    void this.stopAsync();
  }
}
