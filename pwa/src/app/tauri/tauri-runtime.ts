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

/** 是否运行在 Tauri 安卓壳内（UA 含 Android；桌面 WebView2 不含）。 */
export function isAndroidShell(): boolean {
  return isTauri() && /android/i.test(navigator.userAgent);
}

// 论坛账号密码换 JWT 的接口（与原安卓仓库同一端点）。挂在 chahui.app 下直连可达。
// 安卓端必须保留此登录方式：手机读不到浏览器 leveldb，一键登录路线在安卓不存在。
const LOGIN_URL = 'https://chahui.app/main/shireyishunjian-telegram-api/chahua_login.php';

/**
 * 用论坛账号密码登录，换取 JWT（返回纯文本 token）。
 * 密码只在内存中传给接口，不落盘、不写日志、不进 localStorage。
 */
export async function loginWithCredentials(username: string, password: string): Promise<string> {
  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { Accept: 'text/plain' },
    body: new URLSearchParams({ username, password }),
  });
  const text = (await response.text()).trim();
  if (!response.ok || !text) throw new DesktopLoginError(response.status, text || response.statusText);
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

/**
 * 测试包构建标识：每次出测试包递增（b8→b9…），显示在入口页底部并写入启动日志。
 * 用途=确认用户实际运行的是哪个包，避免拿旧包的现象当新包的 bug 排查。
 * 测试包用 release profile 构建（debug profile 无优化，低内存机器上卡）；
 * 标识只表「第几个测试包」，不表构建 profile。
 */
export const DESKTOP_BUILD_TAG = 'b26';

/**
 * 读取浏览器 PWA 已保存的茶话登录态（Rust 侧只读扫描 Chromium Local Storage）。
 * 返回 JWT 候选列表（可能含历史版本），由调用方按 iat 取最新并验活。
 * 动态 import：Web 构建永远不会执行此路径。
 */
export async function readPwaJwt(): Promise<string[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string[]>('read_pwa_jwt');
}

/**
 * 前端日志落盘：走自定义 Rust 命令 frontend_log（Rust 侧 log 宏 → tauri-plugin-log 文件）。
 * 不用 @tauri-apps/plugin-log 的前端 API——实测它在本壳内不落文件（b9 启动后日志零新行）。
 * 日志通道失败必须静默吞掉，绝不能影响业务流程。
 */
async function webLog(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('frontend_log', { level, message });
  } catch {
    // 日志不可用不影响功能
  }
}
export const logInfo = (message: string) => webLog('info', message);
export const logError = (message: string) => webLog('error', message);

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
  downloadUrl?: string;
}

// 版本信息通道（用户要求「更新检查要对上镜像源」）：镜像前缀 → 镜像前缀 → 直连，依次尝试。
// 桌面与安卓分仓发布（用户裁定），各自读自己仓库的 version.json。
// **走原生 XHR 而非 fetch**：fetch 被 monkey-patch 到 plugin-http，而镜像前缀 URL 不是合法
// capabilities pattern（写进 allow 会让整个 http scope 反序列化失败，v1.1.0 事故）；
// XHR 不经 capabilities，WebView 内核层 --no-proxy-server 直连，镜像本身是普通 HTTPS 主机。
const VERSION_URLS = (isAndroidShell()
  ? [
      'https://ghfast.top/https://raw.githubusercontent.com/yibanm/chahua-android-richkobe/main/version.json',
      'https://ghproxy.net/https://raw.githubusercontent.com/yibanm/chahua-android-richkobe/main/version.json',
      'https://raw.githubusercontent.com/yibanm/chahua-android-richkobe/main/version.json',
    ]
  : [
      'https://ghfast.top/https://raw.githubusercontent.com/yibanm/chahua-desktop-richkobe/main/version.json',
      'https://ghproxy.net/https://raw.githubusercontent.com/yibanm/chahua-desktop-richkobe/main/version.json',
      'https://raw.githubusercontent.com/yibanm/chahua-desktop-richkobe/main/version.json',
]);

function xhrJson(url: string): Promise<VersionManifest> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.timeout = 15000;
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(`HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error('network'));
    xhr.ontimeout = () => reject(new Error('timeout'));
    xhr.send();
  });
}

/**
 * 检查桌面客户端更新：拉取 version.json，版本号高于当前则返回新版本信息，否则返回 undefined。
 * 版本比较按数字段逐段比（1.10.0 > 1.9.0），非当前版本的字符串差异不算更新。
 */
export async function fetchDesktopUpdateInfo(
  currentVersion: string,
): Promise<{ version: string; releaseUrl: string; downloadUrl?: string } | undefined> {
  let lastError: unknown;
  for (const url of VERSION_URLS) {
    try {
      const manifest = await xhrJson(url);
      const version = manifest.version;
      if (!version || compareVersions(version, currentVersion) <= 0) return undefined;
      const repo = isAndroidShell() ? 'chahua-android-richkobe' : 'chahua-desktop-richkobe';
      const releaseUrl = manifest.releaseUrl ?? `https://github.com/yibanm/${repo}/releases/tag/v${version}`;
      return { version, releaseUrl, downloadUrl: manifest.downloadUrl };
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
