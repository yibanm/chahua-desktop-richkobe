/**
 * Tauri 桌面壳运行时判定。
 *
 * 该文件只被 Tauri 构建路径依赖，Web/PWA 构建时判定恒为 false，
 * 因此上游 chahua 的 Web 行为不受任何影响。
 */

/** 是否运行在 Tauri 壳内（Tauri 2.x 注入 `__TAURI_INTERNALS__`）。 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 打开官方论坛授权窗口（Rust 侧命令）。
 * 动态 import：Web 构建永远不会执行此路径，不引入 Tauri 运行时依赖。
 */
export async function openAuthWindow(url: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_auth_window', { url });
}

/** 订阅授权窗口捕获到 token 的事件；返回取消订阅函数。 */
export async function onAuthToken(callback: (token: string) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string>('auth-token', (event) => callback(event.payload));
}
