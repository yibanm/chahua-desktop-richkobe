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
import { isTauri, onWindowFocused, openExternalUrl, readClipboard } from '../tauri/tauri-runtime';
import { PanelNavigation } from '../navigation/panel-navigation';
import { AppUpdates } from '../pwa/app-updates';
import { NotificationPrompt } from '../pwa/notification-prompt/notification-prompt';
import { PushNotifications } from '../pwa/push-notifications';
import { ContentScrollbars } from '../scrolling/content-scrollbars';
import { SessionStore } from '../session/session-store';
import { RpcError, RpcErrorCode, RpcTransportError } from '../api/rpc-error';

/** 记住上次成功授权的入口地址，供桌面壳复用。 */
const ENTRY_URL_KEY = 'chahua.desktop.entryUrl';

/**
 * 无记住地址时「浏览器登录」的默认目标：官方应用主入口。
 * 授权入口链接由论坛侧签发（Discuz 共享密钥签 JWT 后重定向回 chahua.app），
 * 桌面壳无法自建服务端授权入口；旧论坛域 shireyishunjian.com 已失效
 * （DNS 指向无关 IP 段），新论坛地址未知，故默认跳应用主入口——
 * 浏览器已有登录态时直达聊天页，无登录态时官方页面自带进入引导。
 * 不指 chahua.app/landing：那是 PWA 安装引导页，与登录无关（用户明确拒绝 PWA 路线）。
 * 用户粘贴过一次论坛帖地址后即被记住，之后「浏览器登录」直接跳该地址。
 */
const DEFAULT_ENTRY_URL = 'https://chahua.app/chats';

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
  protected readonly browserOpenFailed = signal(false);
  // 打开浏览器失败时透出的具体错误文本：吞掉错误会让排障无从下手
  protected readonly browserOpenError = signal('');
  @ViewChild('tokenInput') protected readonly tokenInput?: IonInput;
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
   * 浏览器登录：无条件跳系统默认浏览器。
   * 有记住的入口地址则打开它；没有则打开官方落地页（用户可在浏览器内自行进入论坛帖），
   * 授权完成后复制入口链接回到本窗口，剪贴板感知自动登录。
   */
  protected async browserAuth() {
    const remembered = this.entryLink().trim() || localStorage.getItem(ENTRY_URL_KEY);
    const target = remembered || DEFAULT_ENTRY_URL;
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      this.browserOpenFailed.set(true);
      return;
    }
    if (parsed.protocol !== 'https:') {
      this.browserOpenFailed.set(true);
      return;
    }
    if (remembered) localStorage.setItem(ENTRY_URL_KEY, parsed.href);
    this.entryLinkInvalid.set(false);
    this.browserOpenFailed.set(false);
    this.awaitingBrowserAuth.set(true);
    this.startClipboardPoll();
    try {
      await openExternalUrl(parsed.href);
    } catch (error) {
      this.awaitingBrowserAuth.set(false);
      this.stopClipboardPoll();
      this.browserOpenFailed.set(true);
      this.browserOpenError.set(error instanceof Error ? error.message : String(error));
      console.error('[tauri] open browser failed:', error);
    }
  }

  /** 手动登录：展开令牌输入框并聚焦，供粘贴入口链接 / 裸令牌。 */
  protected manualLogin() {
    this.showPasteBox.set(true);
    this.entryLinkInvalid.set(false);
    // 等一帧让输入框渲染完成再聚焦
    setTimeout(() => void this.tokenInput?.setFocus(), 0);
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
