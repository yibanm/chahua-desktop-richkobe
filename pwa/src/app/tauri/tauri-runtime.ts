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
 * 读取浏览器 PWA 已保存的茶话登录态（Rust 侧只读扫描 Chromium Local Storage）。
 * 返回 JWT 候选列表（可能含历史版本），由调用方按 iat 取最新并验活。
 * 动态 import：Web 构建永远不会执行此路径。
 */
export async function readPwaJwt(): Promise<string[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string[]>('read_pwa_jwt');
}

/** 桌面壳通知权限状态；语义与 Web NotificationPermission 一致，便于复用上游 UI。 */
export type DesktopPermission = 'granted' | 'denied' | 'default';

/**
 * 桌面壳系统通知桥接（tauri-plugin-notification）。
 * WebView2 不提供 Web Notification API，上游基于 ServiceWorker 的推送通道在壳内也不存在，
 * 因此通知必须走原生插件。插件的 sendNotification 是同步投递。
 */
export async function desktopPermission(): Promise<DesktopPermission> {
  const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
  try {
    return (await isPermissionGranted()) ? 'granted' : 'default';
  } catch {
    return 'denied';
  }
}

export async function desktopRequestPermission(): Promise<DesktopPermission> {
  const { requestPermission } = await import('@tauri-apps/plugin-notification');
  try {
    return (await requestPermission()) as DesktopPermission;
  } catch {
    return 'denied';
  }
}

export async function desktopNotify(title: string, body: string): Promise<void> {
  const { isPermissionGranted, sendNotification } = await import('@tauri-apps/plugin-notification');
  if (!(await isPermissionGranted())) return;
  sendNotification({ title, body });
}
