/**
 * Tauri 壳的启动入口。
 *
 * 为什么需要它：官方服务器 `chahui.app` 的 CORS 白名单硬编码为 `https://chahua.app`
 * （实测：请求带任何 Origin，响应恒为 `Access-Control-Allow-Origin: https://chahua.app`，
 * 不回显请求 Origin）。Tauri WebView 的 Origin 是 `http://tauri.localhost`，
 * 前端直连 API 会被 CORS 拦截。
 *
 * 解决办法用官方插件 `@tauri-apps/plugin-http`：它把 `fetch` 交给 Rust 侧执行，
 * 服务端发出的请求不受 CORS 约束。配合 main.ts 里的 `provideHttpClient(withFetch())`，
 * Angular 的全部 HTTP 请求即走 Rust 通道，业务代码无需感知。
 *
 * WebSocket 不经此插件：WS 握手不受 CORS 约束（实测 `Origin: http://tauri.localhost`
 * 同样返回 101 Switching Protocols），且后端鉴权走应用层 JSON-RPC 消息而非握手头，故直连即可。
 *
 * 这里必须用动态 import 加载 ./main：静态 import 会被 ESM 提升到模块体之前求值，
 * 那样 `window.fetch` 的替换就晚于 Angular 引导，只能靠 microtask 时序侥幸生效。
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

// Angular 的 FetchBackend 每次请求都重新查全局 fetch（其源码注释明确支持外部改写），
// 因此在引导前替换即可让所有 HttpClient 请求走 Rust 通道。
window.fetch = tauriFetch as typeof window.fetch;

// 动态 import 不提升，保证上面的替换先于 ./main 的模块求值完成。
await import('./main');
