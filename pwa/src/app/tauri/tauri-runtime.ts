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
