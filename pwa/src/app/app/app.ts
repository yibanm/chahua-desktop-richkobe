import { DOCUMENT, NgOptimizedImage } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  inject,
  isDevMode,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import {
  IonApp,
  IonButton,
  IonContent,
  IonInput,
  IonMenu,
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
import { isTauri, onAuthToken, onWindowFocused, openAuthWindow, openExternalUrl, readClipboard } from '../tauri/tauri-runtime';
import { PanelNavigation } from '../navigation/panel-navigation';
import { AppUpdates } from '../pwa/app-updates';
import { NotificationPrompt } from '../pwa/notification-prompt/notification-prompt';
import { PushNotifications } from '../pwa/push-notifications';
import { ContentScrollbars } from '../scrolling/content-scrollbars';
import { SessionStore } from '../session/session-store';
import { RpcError, RpcErrorCode, RpcTransportError } from '../api/rpc-error';

/** 记住上次成功授权的入口地址，供桌面壳「快捷登录」一键复用。 */
const ENTRY_URL_KEY = 'chahua.desktop.entryUrl';

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
    NgOptimizedImage,
    ContentScrollbars,
    IonApp,
    IonButton,
    IonContent,
    IonInput,
    IonMenu,
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
  // 桌面壳登录：主交互是「跳默认浏览器授权」，回流靠剪贴板感知 + 窗口焦点双触发；
  // 应用内授权窗口降级为显式兜底链接；粘贴框折叠为次要入口。仅 Tauri 下显示。
  protected readonly showDesktopLogin = isTauri();
  protected readonly showPasteBox = signal(false);
  protected readonly entryLink = signal('');
  protected readonly entryLinkInvalid = signal(false);
  protected readonly awaitingBrowserAuth = signal(false);
  private clipboardPoll?: ReturnType<typeof setInterval>;
  private initializationEpoch = 0;
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
    if (this.showDesktopLogin) {
      // 兜底路线：应用内授权窗口捕获到 token 后自动采纳并初始化
      void onAuthToken((token) => {
        this.stopClipboardPoll();
        this.session.adoptToken(token);
        void this.initialize();
      });
      // 主路线回流：从浏览器授权返回应用（窗口重新获焦）时检查剪贴板里的 token
      void onWindowFocused(() => {
        if (this.awaitingBrowserAuth()) void this.tryAdoptClipboardToken();
      });
      inject(DestroyRef).onDestroy(() => this.stopClipboardPoll());
    }
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
    this.slowTimer = setTimeout(() => this.slow.set(true), 10000);
    try {
      await this.session.initialize();
      if (epoch === this.initializationEpoch && this.session.user()) this.notifications.start();
    } catch (error) {
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
   * 主登录路线：在系统默认浏览器打开入口地址，用户授权后 token 经剪贴板回流。
   * 官方重定向硬编码回 chahua.app（浏览器地址栏），桌面应用无法直接接收，
   * 故回流通道为：浏览器里复制入口链接（或授权页一键复制）→ 回到应用窗口 →
   * 焦点回归或轮询读到剪贴板里的 token 即自动登录。凭证始终来自用户自己的账号。
   */
  protected async browserAuth() {
    const url = this.entryLink().trim() || localStorage.getItem(ENTRY_URL_KEY) || '';
    if (!url) {
      // 没有可用入口地址：展开粘贴框让用户提供一次
      this.showPasteBox.set(true);
      this.entryLinkInvalid.set(true);
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      this.showPasteBox.set(true);
      this.entryLinkInvalid.set(true);
      return;
    }
    if (parsed.protocol !== 'https:') {
      this.showPasteBox.set(true);
      this.entryLinkInvalid.set(true);
      return;
    }
    localStorage.setItem(ENTRY_URL_KEY, parsed.href);
    this.entryLinkInvalid.set(false);
    this.awaitingBrowserAuth.set(true);
    this.startClipboardPoll();
    try {
      await openExternalUrl(parsed.href);
    } catch {
      this.awaitingBrowserAuth.set(false);
      this.stopClipboardPoll();
      this.entryLinkInvalid.set(true);
    }
  }

  /** 兜底路线：应用内授权窗口（浏览器不可用或用户不想离开应用时）。 */
  protected async fallbackAuthWindow() {
    const url = this.entryLink().trim() || localStorage.getItem(ENTRY_URL_KEY);
    if (!url) {
      this.showPasteBox.set(true);
      this.entryLinkInvalid.set(true);
      return;
    }
    this.entryLinkInvalid.set(false);
    localStorage.setItem(ENTRY_URL_KEY, url);
    try {
      await openAuthWindow(url);
    } catch {
      this.entryLinkInvalid.set(true);
    }
  }

  /** 轮询剪贴板：浏览器授权期间每 2 秒检查一次，最长 5 分钟。 */
  private startClipboardPoll() {
    this.stopClipboardPoll();
    const deadline = Date.now() + 5 * 60_000;
    this.clipboardPoll = setInterval(() => {
      if (Date.now() > deadline) {
        this.awaitingBrowserAuth.set(false);
        this.stopClipboardPoll();
        return;
      }
      void this.tryAdoptClipboardToken();
    }, 2000);
  }

  private stopClipboardPoll() {
    if (this.clipboardPoll) {
      clearInterval(this.clipboardPoll);
      this.clipboardPoll = undefined;
    }
  }

  /** 从剪贴板文本提取 token 并采纳；提取不到则什么都不做（继续等待）。 */
  protected async tryAdoptClipboardToken() {
    const text = (await readClipboard())?.trim();
    if (!text) return;
    const token = extractToken(text);
    if (!token) return;
    this.stopClipboardPoll();
    this.awaitingBrowserAuth.set(false);
    this.session.adoptToken(token);
    void this.initialize();
  }

  /**
   * 折叠粘贴框的提交：接受「带 token 的入口链接」「裸 JWT」「论坛帖地址」。
   * 前两者直接采纳凭证；论坛帖地址记住后走浏览器授权主路线。
   */
  protected submitEntryLink() {
    const raw = this.entryLink().trim();
    if (!raw) {
      this.entryLinkInvalid.set(true);
      return;
    }
    const token = extractToken(raw);
    if (token) {
      this.entryLinkInvalid.set(false);
      this.session.adoptToken(token);
      void this.initialize();
      return;
    }
    let url: URL | undefined;
    try {
      url = new URL(raw, window.location.origin);
    } catch {
      url = undefined;
    }
    if (url && url.protocol === 'https:') {
      this.entryLink.set(url.href);
      void this.browserAuth();
      return;
    }
    this.entryLinkInvalid.set(true);
  }

  /** 快捷登录：本地已有 token 直接绑定；否则走浏览器授权主路线。 */
  protected quickLogin() {
    if (this.session.token()) {
      void this.initialize();
      return;
    }
    void this.browserAuth();
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
