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

// 论坛账号密码换 JWT 的接口（与安卓端同一端点）。挂在 chahui.app 下，
// 已在 capabilities 的 http:default allow 列表内，且 chahui.app 直连可达（不被 DNS 污染）。
const LOGIN_URL = 'https://chahui.app/main/shireyishunjian-telegram-api/chahua_login.php';

/**
 * 用论坛账号密码登录，换取 JWT。
 * 密码只在内存中传给接口，不落盘、不写日志、不进 localStorage。
 * 接口成功时返回 JWT 纯文本；失败返回 HTTP 401/403（凭证错）或其它状态码。
 */
export async function loginWithCredentials(username: string, password: string): Promise<string> {
  const started = Date.now();
  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { Accept: 'text/plain' },
    body: new URLSearchParams({ username, password }),
  });
  const text = (await response.text()).trim();
  // 登录链路落盘日志（不写凭证内容）：失败时 AI 直接读日志定位，不靠用户截图猜
  const { info, error } = await import('@tauri-apps/plugin-log');
  const ms = Date.now() - started;
  if (!response.ok || !text) {
    await error(`[login] credentials exchange failed: HTTP ${response.status} in ${ms}ms body="${text.slice(0, 80)}"`);
    throw new DesktopLoginError(response.status, text || response.statusText);
  }
  await info(`[login] credentials exchange ok: HTTP ${response.status} in ${ms}ms, token length ${text.length}`);
  return text;
}

/** 登录接口失败：带 HTTP 状态码，供调用方区分「凭证错」与「网络/服务异常」。 */
export class DesktopLoginError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`login failed: HTTP ${status} ${detail}`);
  }
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

/**
 * 用系统默认浏览器打开外部链接。
 * 壳内 WebView 没有 `target="_blank"` 出口（点击静默失败），外链必须交给系统浏览器：
 * 既用于聊天消息里的链接，也用于论坛头像页（该域直连被 DNS 污染，系统浏览器有代理与登录态）。
 */
export async function openExternalUrl(url: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/**
 * 读取桌面客户端自身版本号（来自 tauri.conf.json，打包时写入）。
 * 构建期没有注入 CHAHUA_APP_VERSION，故不能用 appVersion 常量（那是占位串 PWA2-dev）。
 */
export async function desktopAppVersion(): Promise<string | undefined> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return undefined;
  }
}

/** 仓库里 version.json 的结构；只取用到的字段，多余字段忽略。 */
interface VersionManifest {
  version?: string;
  releaseUrl?: string;
}

// 版本信息走 raw 文件而非 GitHub API：实测镜像不能代理 api.github.com（ghfast/ghproxy 均 403），
// 而 raw 通道经镜像可达（200）。多通道依次尝试，任一成功即用；全失败抛错由调用方记 Failed。
// shortcut: 镜像列表写死三条，若某天全部失效需改为可配置或回退直连
const VERSION_URLS = [
  'https://ghfast.top/https://raw.githubusercontent.com/yibanm/chahua-desktop-richkobe/main/version.json',
  'https://ghproxy.net/https://raw.githubusercontent.com/yibanm/chahua-desktop-richkobe/main/version.json',
  'https://raw.githubusercontent.com/yibanm/chahua-desktop-richkobe/main/version.json',
];

/**
 * 检查桌面客户端更新：拉取 version.json，版本号高于当前则返回新版本信息，否则返回 undefined。
 * 版本比较按数字段逐段比（1.10.0 > 1.9.0），非当前版本的字符串差异不算更新。
 */
export async function fetchDesktopUpdateInfo(
  currentVersion: string,
): Promise<{ version: string; releaseUrl: string } | undefined> {
  let lastError: unknown;
  for (const url of VERSION_URLS) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const manifest = (await response.json()) as VersionManifest;
      const version = manifest.version;
      if (!version || compareVersions(version, currentVersion) <= 0) return undefined;
      const releaseUrl =
        manifest.releaseUrl ?? `https://github.com/yibanm/chahua-desktop-richkobe/releases/tag/v${version}`;
      return { version, releaseUrl };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('version manifest unreachable');
}

/** 逐段数字比较版本号；缺段按 0 计，非数字段按 0 计。返回 >0 表示 a 更新。 */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
