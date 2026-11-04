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
import { isTauri, onAuthToken, openAuthWindow } from '../tauri/tauri-runtime';
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
  // 桌面壳没有地址栏：官方入口是带 token 的外部链接，Web 端可直接点链接进入，
  // 壳内必须提供粘贴入口，否则无登录态时用户无路可走。仅 Tauri 下显示。
  protected readonly showEntryLinkInput = isTauri();
  protected readonly entryLink = signal('');
  protected readonly entryLinkInvalid = signal(false);
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
    // 授权窗口捕获到 token 后自动采纳并初始化（桌面壳一键登录的回调侧）
    if (this.showEntryLinkInput) {
      void onAuthToken((token) => {
        this.session.adoptToken(token);
        void this.initialize();
      });
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
   * 桌面壳登录入口：接受「带 token 的入口链接」「裸 JWT」「论坛帖地址」三种粘贴格式。
   * - 带 token 的链接 / 裸 JWT：直接采纳凭证；
   * - 论坛帖地址：记住该地址并打开授权窗口，用户在窗口内登录官方论坛并点帖中入口链接，
   *   应用捕获重定向 URL 上的 token 后自动登录（见 Rust 侧 auth_window）。
   * 凭证始终来自用户自己的账号，不做任何认证绕过。
   */
  protected async submitEntryLink() {
    const raw = this.entryLink().trim();
    if (!raw) return;
    let token: string | undefined;
    let url: URL | undefined;
    try {
      url = new URL(raw, window.location.origin);
      token = url.searchParams.get('token') ?? undefined;
    } catch {
      url = undefined;
    }
    // 裸 JWT 形如 header.payload[.signature]，base64url 段以 eyJ 开头的是 header
    if (!token && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(raw)) token = raw;
    if (token) {
      this.entryLinkInvalid.set(false);
      this.session.adoptToken(token);
      void this.initialize();
      return;
    }
    if (url && url.protocol === 'https:') {
      // 论坛帖地址：记住后交给 Rust 侧开授权窗口，供下次一键快捷登录复用
      this.entryLinkInvalid.set(false);
      localStorage.setItem(ENTRY_URL_KEY, url.href);
      try {
        await openAuthWindow(url.href);
      } catch {
        this.entryLinkInvalid.set(true);
      }
      return;
    }
    this.entryLinkInvalid.set(true);
  }

  /**
   * Quick login: reuse the entry address remembered from the last successful authorization to open the authorization window directly.
   * If there is no remembered address but a locally stored token exists, try binding with it directly;
   * if neither is present, show a hint asking to paste the address once first (the address is operational info issued by the official forum and is not hardcoded in the repo).
   */
  protected async quickLogin() {
    const remembered = localStorage.getItem(ENTRY_URL_KEY);
    if (remembered) {
      try {
        await openAuthWindow(remembered);
        return;
      } catch {
        localStorage.removeItem(ENTRY_URL_KEY);
      }
    }
    if (this.session.token()) {
      void this.initialize();
      return;
    }
    this.entryLinkInvalid.set(true);
  }
}
