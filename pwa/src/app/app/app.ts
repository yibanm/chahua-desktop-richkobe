import { DecimalPipe, DOCUMENT, NgOptimizedImage } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  inject,
  isDevMode,
  linkedSignal,
  signal,
  ViewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import {
  IonApp,
  IonButton,
  IonContent,
  IonInput,
  IonMenu,
  IonProgressBar,
  IonRouterOutlet,
  IonSpinner,
  IonSplitPane,
  IonToast,
  iosTransitionAnimation,
  isPlatform,
} from '@ionic/angular';
import { translateSignal, TranslocoPipe } from '@jsverse/transloco';
import { filter, map, TimeoutError } from 'rxjs';
import { ChatLink } from '../chats/chat-link/chat-link';
import { ChatList } from '../chats/chat-list/chat-list';
import { listSelection, ListTab, type ListSelection } from '../chats/list-tabs';
import { DESKTOP_BUILD_TAG, isAndroidShell, isTauri, loginWithCredentials, DesktopLoginError, readPwaJwt } from '../tauri/tauri-runtime';
import { PanelNavigation } from '../navigation/panel-navigation';
import { AppUpdates } from '../pwa/app-updates';
import { NotificationPrompt } from '../pwa/notification-prompt/notification-prompt';
import { PushNotifications } from '../pwa/push-notifications';
import { ContentScrollbars } from '../scrolling/content-scrollbars';
import { SessionStore } from '../session/session-store';
import { RpcError, RpcErrorCode, RpcTransportError } from '../api/rpc-error';

enum EntryState {
  Loading = 'loading',
  Slow = 'slow',
  Missing = 'missing',
  Expired = 'expired',
  Network = 'network',
  Server = 'server',
  Failed = 'failed',
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: {
    '(window:popstate)': 'browserTransition.set($event.hasUAVisualTransition)',
    '(document:keydown)': 'escapeKey($event)',
  },
  imports: [
    DecimalPipe,
    NgOptimizedImage,
    ContentScrollbars,
    IonApp,
    IonButton,
    IonContent,
    IonInput,
    IonMenu,
    IonProgressBar,
    IonRouterOutlet,
    IonSpinner,
    IonSplitPane,
    IonToast,
    ChatList,
    ChatLink,
    NotificationPrompt,
    TranslocoPipe,
  ],
})
export class App {
  private readonly router = inject(Router);
  private readonly panels = inject(PanelNavigation);
  private readonly document = inject(DOCUMENT);
  private readonly notifications = inject(PushNotifications);
  protected readonly landingPage = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => /^\/landing(?:[?/#]|$)/.test(this.router.url)),
    ),
    { initialValue: /^\/landing(?:[?/#]|$)/.test(location.pathname) },
  );
  private readonly routeSelection = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => listSelection(this.router.routerState.snapshot.root)),
    ),
    {
      initialValue: listSelection(this.router.routerState.snapshot.root),
      equal: (a, b) => a?.tab === b?.tab && a?.archived === b?.archived && a?.requestHistory === b?.requestHistory,
    },
  );
  protected readonly sidebarSelection = linkedSignal({
    source: this.routeSelection,
    computation: (selection, previous): ListSelection =>
      selection ?? previous?.value ?? { tab: ListTab.Messages, archived: false, requestHistory: false },
  });
  protected readonly browserTransition = signal(false);
  protected readonly session = inject(SessionStore);
  protected readonly loading = signal(false);
  private readonly slow = signal(false);
  private readonly error = signal<EntryState | undefined>(undefined);
  protected readonly entryState = computed(() =>
    this.loading() ? (this.slow() ? EntryState.Slow : EntryState.Loading) : (this.error() ?? EntryState.Missing),
  );
  protected readonly needsLogin = computed(() => [EntryState.Missing, EntryState.Expired].includes(this.entryState()));
  protected readonly EntryState = EntryState;
  // 桌面壳登录：主路线读浏览器 PWA 已保存的登录态（Chromium localStorage 明文 JWT），
  // 命中即提示「已识别到 PWA 的登录信息，自动登录」；未命中引导用户用 CookieXport 导出后粘贴。
  protected readonly showDesktopLogin = isTauri();
  // 正式版（tag 触发的 CI 构建注入 CHAHUA_OFFICIAL=true）界面不显示任何构建标识；
  // 测试包才显示构建号（用户裁定：正式版就是正式版，构建版才带号）。日志仍记录供排查。
  protected readonly buildTag =
    typeof CHAHUA_OFFICIAL !== 'undefined' && CHAHUA_OFFICIAL ? '' : DESKTOP_BUILD_TAG;
  // 账号密码登录在全部 Tauri 壳开放（桌面+安卓）：接口实测可用（200/JWT/2.7~5.05s/不校验 UA），
  // 安卓读不到浏览器 leveldb 必须靠它；桌面作为可验证的登录途径保留（用户 2026-11-06 要求加回）
  protected readonly showPasswordLogin = isTauri();
  // 一键登录仅桌面：移动端未注册 read_pwa_jwt（扫浏览器 leveldb 是 Windows 专有）
  protected readonly showOneClick = isTauri() && !isAndroidShell();
  protected readonly showPasswordBox = signal(false);
  protected readonly passwordUsername = signal('');
  protected readonly passwordValue = signal('');
  protected readonly passwordError = signal('');
  protected readonly passwordBusy = signal(false);
  @ViewChild('passwordInput') protected readonly passwordInput?: IonInput;
  protected readonly showPasteBox = signal(false);
  protected readonly entryLink = signal('');
  protected readonly entryLinkInvalid = signal(false);
  // 识别到浏览器登录态时的成功提示
  protected readonly pwaJwtFound = signal(false);
  // 识别失败时的引导提示（CookieXport 导出流程）
  protected readonly pwaJwtMissing = signal(false);
  // 登录进度（0-1）：扫描 8→35，验证连接 60，进入 100；失败归零
  protected readonly loginProgress = signal(0);
  // 扫描进行中标记：按钮禁用 + 文案变化，避免用户以为卡死连点
  protected readonly pwaScanning = signal(false);
  // 识别失败的具体原因（扫描异常 / 候选全部验活失败），透出便于排障
  protected readonly pwaScanError = signal('');
  @ViewChild('tokenInput') protected readonly tokenInput?: IonInput;
  private initializationEpoch = 0;
  private slowAutoRetried = false;
  private slowTimer?: ReturnType<typeof setTimeout>;
  protected readonly updates = inject(AppUpdates);
  protected readonly updateReady = translateSignal('app.updateReady');
  private readonly updateLater = translateSignal('app.updateLater');
  private readonly updateNow = translateSignal('app.updateNow');
  protected readonly updateButtons = computed(() => [
    { text: this.updateLater(), role: 'cancel' },
    { text: this.updateNow(), handler: this.updates.reload },
  ]);
  protected readonly splitPaneVisible = signal(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.slowTimer));
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationEnd) void this.panels.dismissTransientOverlays();
    });
    afterRenderEffect(() => this.updates.setInteractive(!this.landingPage() && !!this.session.user()));
    this.session.restoreToken();
    if ((!this.session.token() && !isDevMode()) || (this.landingPage() && !isPlatform('pwa'))) {
      this.loading.set(false);
    } else {
      void this.initialize();
    }
  }

  protected prepareTransition(outlet: IonRouterOutlet) {
    outlet.animated = !this.splitPaneVisible();
    // Finish Ionic's page visibility cleanup even when Safari already played the transition.
    outlet.animation =
      this.browserTransition() && this.router.currentNavigation()?.trigger === 'popstate'
        ? (baseEl, options) => iosTransitionAnimation(baseEl, options).duration(0)
        : iosTransitionAnimation;
  }

  /**
   * Page-level Escape: in a thread → parent chat positioned at the thread root message, in a chat →
   * the chat list. Defers to inputs and Ionic overlays, which handle Escape themselves.
   */
  protected escapeKey(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    const active = this.document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;
    // A closed inline toast or alert stays in the DOM as .overlay-hidden, and a split-pane menu is
    // permanently visible without it, so each overlay needs its own "presented" marker.
    if (
      this.document.querySelector(
        'ion-alert:not(.overlay-hidden), ion-action-sheet:not(.overlay-hidden), ion-menu.show-menu, ion-modal:not(.overlay-hidden), ion-toast:not(.overlay-hidden)',
      )
    )
      return;
    const segments = this.router.parseUrl(this.router.url).root.children['primary']?.segments.map((s) => s.path);
    if (segments?.length === 5 && segments[0] === 'chats' && segments[1] === 'chat' && segments[3] === 'thread')
      void this.router.navigate(['/chats/chat', segments[2]], { replaceUrl: true, fragment: `msg=${segments[4]}` });
    else if (segments?.length === 3 && segments[0] === 'chats' && segments[1] === 'chat')
      void this.router.navigate(['/chats'], { replaceUrl: true });
  }

  protected async initialize() {
    if (this.loading()) return;
    const epoch = ++this.initializationEpoch;
    this.loading.set(true);
    this.slow.set(false);
    this.error.set(undefined);
    // 启动链日志点：自测/排障时从 weblog 直接看 initialize 走到哪一步卡住
    void import('../tauri/tauri-runtime').then((m) => m.logInfo(`[init] start epoch=${epoch}`));
    this.slowTimer = setTimeout(() => {
      this.slow.set(true);
      // 桌面壳：Slow 态自动重试一次初始化，免去用户手动点「刷新」（官方 web 版
      // 的 SW 更新 reload 在壳内已禁用，此处的慢来自冷连接/初始化，重试可自愈）。
      // 必须先作废卡住的第一次初始化（epoch++ 且 loading 复位），否则 initialize
      // 的 `if (this.loading()) return` 守卫会把重试直接挡掉。
      if (isTauri() && !this.slowAutoRetried) {
        this.slowAutoRetried = true;
        this.initializationEpoch++;
        this.loading.set(false);
        void this.initialize();
      }
    }, 10000);
    try {
      await this.session.initialize();
      void import('../tauri/tauri-runtime').then((m) =>
        m.logInfo(`[init] ok epoch=${epoch} user=${this.session.user() ? 'yes' : 'no'}`),
      );
      if (epoch === this.initializationEpoch && this.session.user()) this.notifications.start();
    } catch (error) {
      void import('../tauri/tauri-runtime').then((m) =>
        m.logError(`[init] failed epoch=${epoch}: ${error instanceof Error ? error.message : String(error)}`),
      );
      if (epoch !== this.initializationEpoch) return;
      this.error.set(
        error instanceof TimeoutError || error instanceof RpcTransportError
          ? EntryState.Network
          : error instanceof RpcError && error.code === RpcErrorCode.Unauthorized
            ? EntryState.Expired
            : error instanceof RpcError && [RpcErrorCode.Unavailable, RpcErrorCode.Internal].includes(error.code)
              ? EntryState.Server
              : EntryState.Failed,
      );
    } finally {
      if (epoch !== this.initializationEpoch) return;
      clearTimeout(this.slowTimer);
      this.loading.set(false);
    }
  }

  /**
   * 一键登录（唯一主路线）：读取浏览器 PWA 已保存的茶话登录态。
   * Chromium 的 localStorage 不加密，JWT 明文存于 leveldb；Rust 侧只读扫描。
   * 命中多个候选时按 JWT 的 iat 取最新，逐个验活后采纳并进入聊天列表；
   * 全部未命中或验活失败则给出 CookieXport 导出引导（用户裁定的兜底）。
   */
  protected async oneClickLogin() {
    if (this.pwaScanning()) return;
    this.pwaJwtMissing.set(false);
    this.pwaJwtFound.set(false);
    this.pwaScanError.set('');
    this.pwaScanning.set(true);
    this.loginProgress.set(0.08);
    let candidates: string[] = [];
    try {
      candidates = await readPwaJwt();
    } catch (error) {
      this.pwaScanning.set(false);
      this.loginProgress.set(0);
      this.pwaScanError.set(error instanceof Error ? error.message : String(error));
      this.pwaJwtMissing.set(true);
      return;
    }
    this.pwaScanning.set(false);
    if (!candidates.length) {
      this.loginProgress.set(0);
      this.pwaJwtMissing.set(true);
      return;
    }
    // 按 iat 从新到旧排序：leveldb 里可能残留历史版本 token
    const sorted = candidates
      .map((token) => ({ token, iat: jwtIssuedAt(token) }))
      .sort((a, b) => b.iat - a.iat);
    this.pwaJwtFound.set(true);
    this.loginProgress.set(0.35);
    for (const { token } of sorted) {
      this.session.adoptToken(token);
      this.loginProgress.set(0.6);
      try {
        // 连接初始化不套 5 秒硬限：WS 冷握手实测数秒，掐掉会把有效令牌误判失效
        // （用户实测正确密码登录失败即此因）。5 秒限保留在凭证交换/本地扫描步骤。
        // initialize 自带 30 秒 deadline + Slow 自动重试，不会无限转圈。
        await this.initialize();
        if (this.session.user()) {
          this.loginProgress.set(1);
          // 登录成功统一落聊天列表：入口链接可能带邀请路径，用户要求不弹群
          void this.router.navigateByUrl('/chats');
          return;
        }
      } catch {
        // 该候选已失效（吊销/过期），继续试下一个
      }
    }
    this.loginProgress.set(0);
    this.pwaJwtFound.set(false);
    this.pwaScanError.set('stored-token-rejected');
    this.pwaJwtMissing.set(true);
    // 失败后清理 transport，避免后台无限重连拖卡整机
    this.session.logout();
  }

  /** 手动登录：展开令牌输入框并聚焦，供粘贴 CookieXport 导出的 JWT 或入口链接。 */
  protected manualLogin() {
    this.showPasswordBox.set(false);
    this.showPasteBox.set(true);
    this.entryLinkInvalid.set(false);
    // 等一帧让输入框渲染完成再聚焦
    setTimeout(() => void this.tokenInput?.setFocus(), 0);
  }

  /** 账号密码登录（安卓壳）：展开表单并聚焦用户名框。论坛账号，与原安卓端同一接口。 */
  protected passwordLogin() {
    this.showPasteBox.set(false);
    this.passwordError.set('');
    this.showPasswordBox.set(true);
    setTimeout(() => void this.passwordInput?.setFocus(), 0);
  }

  /**
   * 提交账号密码：换取 JWT 后复用既有采纳与初始化流程，落聊天列表。
   * 密码只存在组件信号里，提交后即清空，不落 localStorage、不进日志。
   */
  protected async submitPasswordLogin() {
    if (this.passwordBusy()) return;
    const username = this.passwordUsername().trim();
    const password = this.passwordValue();
    if (!username || !password) {
      this.passwordError.set('empty');
      return;
    }
    this.passwordBusy.set(true);
    this.passwordError.set('');
    this.loginProgress.set(0.35);
    let token: string;
    let exchangeOk = false;
    try {
      // 凭证交换限时 15 秒：实测官方接口本身耗时 2.7~5.05 秒（用户监测页双 UA 实测），
      // 5 秒硬限会掐掉正常登录；15 秒仍保证「不会无限等」的原意
      token = await Promise.race([
        loginWithCredentials(username, password),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('login-timeout-15s')), 15000)),
      ]);
      exchangeOk = true;
    } catch (error) {
      this.passwordValue.set('');
      this.passwordBusy.set(false);
      this.loginProgress.set(0);
      this.passwordError.set(
        error instanceof DesktopLoginError && [401, 403].includes(error.status) ? 'credentials' : 'failed',
      );
      return;
    }
    this.passwordValue.set('');
    this.session.adoptToken(token);
    this.loginProgress.set(0.6);
    // 连接初始化不套硬限：冷握手可达数秒，掐掉会把正确凭证误判失败
    await this.initialize();
    this.passwordBusy.set(false);
    if (this.session.user()) {
      this.loginProgress.set(1);
      void this.router.navigateByUrl('/chats');
    } else if (!exchangeOk) {
      this.loginProgress.set(0);
      this.session.logout();
    } else {
      this.loginProgress.set(0);
    }
  }

  /**
   * 粘贴框提交：接受「带 token 的入口链接」或「裸 JWT」。
   * 采纳后统一进入聊天列表，不弹群组邀请页。
   */
  protected submitEntryLink() {
    const raw = this.entryLink().trim();
    if (!raw) {
      this.entryLinkInvalid.set(true);
      return;
    }
    const token = extractToken(raw);
    if (!token) {
      this.entryLinkInvalid.set(true);
      return;
    }
    this.entryLinkInvalid.set(false);
    this.session.adoptToken(token);
    void this.initialize().then(() => void this.router.navigateByUrl('/chats'));
  }
}

/** 从「带 token 的链接」或「裸 JWT」文本中提取凭证；都不是则返回 undefined。 */
function extractToken(raw: string): string | undefined {
  try {
    const token = new URL(raw, window.location.origin).searchParams.get('token');
    if (token) return token;
  } catch {
    // 不是 URL，继续按裸 JWT 判断
  }
  // 裸 JWT 形如 header.payload[.signature]，base64url 段以 eyJ 开头的是 header
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(raw)) return raw;
  return undefined;
}

/** 解 JWT payload 的 iat（秒）；解析失败返回 0，仅用于候选排序，不做校验。 */
function jwtIssuedAt(token: string): number {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const iat = JSON.parse(json).iat;
    return typeof iat === 'number' ? iat : 0;
  } catch {
    return 0;
  }
}
