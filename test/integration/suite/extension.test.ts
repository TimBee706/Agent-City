import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Claude City smoke test', () => {
  test('extension activates and registers its commands', async () => {
    const ext = vscode.extensions.getExtension('local.claude-city');
    assert.ok(ext, 'extension local.claude-city not found');
    const api = (await ext.activate()) as { getState(): { source: string } };
    assert.ok(ext.isActive, 'extension did not activate');
    assert.strictEqual(typeof api.getState, 'function');

    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'claudeCity.open',
      'claudeCity.refresh',
      'claudeCity.toggleDemoData',
      'claudeCity.installHooks',
      'claudeCity.uninstallHooks',
      'claudeCity.importWorkspacesFromFolder',
      'claudeCity.removeWorkspaceRoot',
      'claudeCity.removeWorkspace',
    ]) {
      assert.ok(commands.includes(id), `command ${id} not registered`);
    }
  });

  test('open command creates the city panel without throwing', async () => {
    await vscode.commands.executeCommand('claudeCity.open');
    await vscode.commands.executeCommand('claudeCity.refresh');
  });
});

suite('Claude City settings', () => {
  test('contributes the phase 3-5 settings with safe defaults', () => {
    const c = vscode.workspace.getConfiguration('claudeCity');
    assert.strictEqual(c.get('pollIntervalSeconds'), 5);
    assert.strictEqual(c.get('hookBridge.enabled'), true);
    assert.strictEqual(c.get('hookBridge.port'), 47821);
    assert.strictEqual(c.get('ambient.dayNight'), true);
    assert.deepStrictEqual(c.get('workspaceRoots'), []);
    assert.strictEqual(c.inspect('workspaceRoots')?.globalValue, undefined, 'tests must not write user settings');
  });
});
