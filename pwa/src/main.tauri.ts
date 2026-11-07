/**
 * Tauri 壳的启动入口。
 *
 * 为什么需要它：官方服务器 `chahui.app` 的 CORS 白名单硬编码为 `https://chahua.app`
 * （实测：请求带任何 Origin，响应恒为 `Access-Control-Allow-Origin: https://chahua.app`，
 * 不回显请求 Origin）。Tauri WebView 的 Origin 是 `http://tauri.localhost`，
 * 前端直连 API 会被 CORS 拦截。
 *
 * 解决办法用官方插件 `@tauri-apps/plugin-http`：它把请求交给 Rust 侧执行，
 * 服务端发出的请求不受 CORS 约束。配合 main.ts 里的 `provideHttpClient(withFetch())`，
 * Angular 发往 API 域名的请求即走 Rust 通道，业务代码无需感知。
 *
 * 但本地资源（i18n 文案、manifest 等相对路径请求）必须走 WebView 原生 fetch：
 * Tauri 的 asset protocol 是 WebView2 的虚拟主机映射（SetVirtualHostNameToFolderMapping），
 * 只在 WebView 进程内生效，Rust 侧的 reqwest 请求 `tauri.localhost` 解析不到任何服务。
 * 因此这里按 URL 分流：本地/相对路径 → 原生 fetch；外部 http(s) → plugin-http。
 *
 * WebSocket 不经此插件：WS 握手不受 CORS 约束（实测 `Origin: http://tauri.localhost`
 * 同样返回 101 Switching Protocols），且后端鉴权走应用层 JSON-RPC 消息而非握手头，故直连即可。
 *
 * 这里必须用动态 import 加载 ./main：静态 import 会被 ESM 提升到模块体之前求值，
 * 那样 `window.fetch` 的替换就晚于 Angular 引导，只能靠 microtask 时序侥幸生效。
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

const nativeFetch = window.fetch.bind(window);

// 绕系统代理在 Rust 侧做（setup 里设 NO_PROXY=*，reqwest 系统代理匹配器读该环境变量全排除=直连），
// JS 层不传 proxy 参数：b22 实测传 proxy 参数会导致前端入口模块跑不完（无 boot 日志行），已回退。
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const isLocal = !/^https?:\/\//i.test(url) || /tauri\.localhost/i.test(url);
  return isLocal
    ? nativeFetch(input, init)
    : (tauriFetch(input as Parameters<typeof tauriFetch>[0], init) as unknown as Promise<Response>);
}) as typeof window.fetch;

// 动态 import 不提升，保证上面的替换先于 ./main 的模块求值完成。
await import('./main');

// 前端日志落盘走自定义 Rust 命令 frontend_log（tauri-runtime 的 logInfo/logError）。
// @tauri-apps/plugin-log 的前端 info/error 在本壳内实测不落文件（b9 启动后日志零新行），弃用。
// 登录/网络失败时 AI 直接读 %LOCALAPPDATA%/com.richkobe.chahuatauri/logs/ 定位，不靠截图猜。
// 构建自标识：每次出测试包改 tauri-runtime 的 DESKTOP_BUILD_TAG，启动即落日志，
// 用于确认用户跑的到底是哪个包（此前出现过日志全空=跑的旧包的误判）。
// 走自定义 frontend_log 命令：plugin-log 前端 API 实测不落文件。
void import('./app/tauri/tauri-runtime')
  .then((m) =>
    m.logInfo(
      `[boot] build=${m.DESKTOP_BUILD_TAG} official=${typeof CHAHUA_OFFICIAL !== 'undefined' && CHAHUA_OFFICIAL} ua=${navigator.userAgent.slice(0, 60)}`,
    ),
  )
  .catch(() => {});

// 外链交给系统默认浏览器：壳内 WebView 没有 target="_blank" 出口，点击会静默失败。
// 用 document 级委托一处覆盖所有 <a>（markdown 渲染的、模板里写死的都算），
// 不逐个改上游组件。只拦外部 http(s)，应用内路由与 internal 链接（自带 preventDefault）不受影响。
// **必须用冒泡阶段**（不能 capture）：媒体预览等组件在自己的 (click) 里 preventDefault，
// 捕获阶段会抢在组件之前把预览劫持去浏览器（用户实测复现）；冒泡阶段先让组件处理，
// 再用 defaultPrevented 跳过已被组件接管的点击。
const { openExternalUrl } = await import('./app/tauri/tauri-runtime');
// 捕获层委托（限 markdown 容器内）：markdown 渲染的外链锚点在上游组件层带 stopPropagation，
// 冒泡阶段到不了 document（b16 改冒泡后外链回归死链）；捕获阶段先于组件气泡处理器执行，
// 只拦外部 http(s) 且非 internal 的锚点，internal 链接留给组件自己的路由处理。
document.addEventListener(
  'click',
  (event) => {
    if (event.defaultPrevented) return;
    const anchor = (event.target as Element | null)?.closest?.('app-message-text a[href], app-markdown-body a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href) || /tauri\.localhost/i.test(href)) return;
    if (anchor.hasAttribute('internal')) return;
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(href).catch(() => {});
  },
  true,
);
// 冒泡层委托（全局兜底）：处理无组件处理器的裸外链锚点；组件已接管的点击由 defaultPrevented 跳过
document.addEventListener('click', (event) => {
  if (event.defaultPrevented) return;
  const anchor = (event.target as Element | null)?.closest?.('a[href]');
  if (!anchor) return;
  const href = anchor.getAttribute('href') ?? '';
  if (!/^https?:\/\//i.test(href) || /tauri\.localhost/i.test(href)) return;
  if (anchor.hasAttribute('internal') || anchor.getAttribute('routerlink') != null) return;
  event.preventDefault();
  event.stopPropagation();
  void openExternalUrl(href).catch(() => {});
});

// 连接预热：官方 API 在 Cloudflare 后，冷启动首次 TLS+CF 握手是登录慢的主因之一。
// 启动即发一次预期 401 的请求暖连接池，fire-and-forget，失败无副作用。
void tauriFetch('https://chahui.app/_api/users/me', { method: 'GET' }).catch(() => {});
