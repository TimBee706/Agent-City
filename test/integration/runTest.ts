import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * @vscode/test-electron spawns VS Code with `shell: true` on Windows and does not quote
 * arguments, so a project path containing spaces (e.g. "C:\VSO\Agent City") is split.
 * Work around it by pointing a space-free directory junction at the project root.
 */
function spaceFreeRoot(root: string): string {
  if (process.platform !== 'win32' || !root.includes(' ')) return root;
  const link = path.join(os.tmpdir(), 'claude-city-dev');
  try {
    if (fs.existsSync(link)) {
      if (fs.realpathSync(link).toLowerCase() === fs.realpathSync(root).toLowerCase()) return link;
      fs.rmSync(link, { recursive: false, force: true });
    }
    fs.symlinkSync(root, link, 'junction');
    return link;
  } catch (err) {
    console.warn('Could not create junction, using original path:', err);
    return root;
  }
}

async function main(): Promise<void> {
  // When launched from a terminal inside VS Code / Claude Code this is set and would make
  // Code.exe behave like plain Node ("bad option: --extensionTestsPath").
  delete process.env.ELECTRON_RUN_AS_NODE;

  const root = spaceFreeRoot(path.resolve(__dirname, '../../../'));
  const extensionTestsPath = path.join(root, 'out', 'test', 'integration', 'suite', 'index');
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath,
      launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'],
    });
  } catch (err) {
    console.error('Integration tests failed:', err);
    process.exit(1);
  }
}

void main();
