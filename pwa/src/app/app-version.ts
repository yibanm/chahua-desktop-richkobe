// 上报身份（X-App-Version 头与会话握手）：服务器据此区分官方/非官方与哪个壳（用户要求）。
// 构建期注入值仅桌面/安卓壳有；安卓壳再按 UA 换成安卓仓库名。Web 版保持上游占位值不变。
const injected = typeof CHAHUA_APP_VERSION === 'undefined' ? undefined : CHAHUA_APP_VERSION;
const isAndroid = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
export const appVersion = injected ? (isAndroid ? 'chahua-android-richkobe' : injected) : 'PWA2-dev';
