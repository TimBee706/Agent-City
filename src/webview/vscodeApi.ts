import type { WebviewToExtensionMessage } from '../shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

function getApi(): VsCodeApi | undefined {
  if (api) return api;
  try {
    api = acquireVsCodeApi();
  } catch {
    api = undefined; // e.g. when rendered outside VS Code
  }
  return api;
}

export function postToExtension(message: WebviewToExtensionMessage): void {
  getApi()?.postMessage(message);
}

export function getPersistedUiState<T>(): T | undefined {
  return getApi()?.getState() as T | undefined;
}

export function setPersistedUiState<T>(state: T): void {
  getApi()?.setState(state);
}
