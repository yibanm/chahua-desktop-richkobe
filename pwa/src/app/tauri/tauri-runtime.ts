/**
 * Tauri 壳运行时判定与原生能力桥接。
 *
 * 该文件只被 Tauri 构建路径依赖，Web/PWA 构建时判定恒为 false，
 * 因此上游 chahua 的 Web 行为不受任何影响。
 */

/** 是否运行在 Tauri 壳内（Tauri 2.x 注入 `__TAURI_INTERNALS__`）。 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 在系统默认浏览器打开外部链接（官方插件 opener）。
 * 动态 import：Web 构建永远不会执行此路径，不引入 Tauri 运行时依赖。
 */
export async function openExternalUrl(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/**
 * 打开应用内授权窗口（Rust 侧命令），作为浏览器路线的兜底。
 */
export async function openAuthWindow(url: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_auth_window', { url });
}

/** 读取系统剪贴板文本（官方插件 clipboard-manager）。读取失败返回 undefined。 */
export async function readClipboard(): Promise<string | undefined> {
  try {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
    return (await readText()) ?? undefined;
  } catch {
    return undefined;
  }
}

/** 订阅授权窗口捕获到 token 的事件；返回取消订阅函数。 */
export async function onAuthToken(callback: (token: string) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string>('auth-token', (event) => callback(event.payload));
}

/** 订阅主窗口重新获得焦点的事件；返回取消订阅函数。 */
export async function onWindowFocused(callback: () => void): Promise<() => void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().onFocusChanged(({ payload }) => {
    if (payload) callback();
  });
}
