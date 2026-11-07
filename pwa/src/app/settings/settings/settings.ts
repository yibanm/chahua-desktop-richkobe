import { Component, computed, inject, isDevMode, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { translateSignal, TranslocoPipe } from '@jsverse/transloco';
import {
  chatbubblesOutline,
  constructOutline,
  eyeOutline,
  languageOutline,
  logOutOutline,
  logoGithub,
  notificationsOutline,
  refreshOutline,
} from 'ionicons/icons';
import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { AppUpdates, UpdateCheckResult } from '../../pwa/app-updates';
import { DiagnosticsCopy } from '../../pwa/diagnostics-copy';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { devBackendEnabled, SessionStore } from '../../session/session-store';
import { isAndroidShell, isTauri, openExternalUrl } from '../../tauri/tauri-runtime';
import { localeLabels } from '../locale';
import { Preferences } from '../preferences';

// 论坛（Discuz）头像设置页：后端无用户头像写接口，头像由论坛侧维护
const AVATAR_PAGE_URL = 'https://www.shireyishunjian.com/main/home.php?mod=spacecp&ac=avatar';
// 本项目源代码仓库（AGPL-3.0：改造后分发须公开全部改动）；安卓构建指向安卓仓库（用户 2026-11-07 指令）
const SOURCE_REPO_URL = isAndroidShell()
  ? 'https://github.com/yibanm/chahua-android-richkobe'
  : 'https://github.com/yibanm/chahua-desktop-richkobe';

@Component({
  selector: 'app-settings',
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  imports: [
    ChatAvatar,
    DiagnosticsCopy,
    RouterLink,
    ContentScrollbars,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonInput,
    IonTitle,
    IonSpinner,
    IonToolbar,
    TranslocoPipe,
  ],
  host: { class: 'ion-page' },
})
export class Settings {
  private readonly panels = inject(PanelNavigation);

  protected readonly session = inject(SessionStore);
  // 桌面壳专属：设置页提供退出登录入口（Web 版靠清浏览器数据退出，壳内没有该途径）
  protected readonly isDesktopShell = isTauri();
  protected readonly logOutOutline = logOutOutline;
  protected readonly githubIcon = logoGithub;

  /** 开源项目入口：用系统浏览器打开本仓库（AGPL 要求公开改动源码，顺带给出出处）。 */
  protected openSource() {
    void openExternalUrl(SOURCE_REPO_URL).catch(() => {});
  }

  /** 论坛头像设置页：壳内 WebView 打不开（无论坛登录态 + 该域直连被 DNS 污染），交系统浏览器。 */
  protected openAvatarPage() {
    void openExternalUrl(AVATAR_PAGE_URL).catch(() => {});
  }

  protected logout() {
    this.session.logout();
    if (isTauri()) {
      // 壳内 WebView 历史栈与路由 depth 不可靠，panels.close() 的 historyGo(-depth)
      // 会算错导致浮层不关（桌面「退出不自动关闭」、安卓「退出失败」均为此因）。
      // 清 token 后重载直达入口屏；启动遮罩为深色，无白闪。Web 版保持上游 close 逻辑。
      window.location.reload();
    } else {
      void this.panels.close();
    }
  }

  /**
   * 「立即更新」：桌面壳无 SW 热更新，reload 只会白刷新一次，
   * 故壳内改为用系统浏览器打开 Release 页下载安装包覆盖安装。
   */
  protected updateNow() {
    if (this.isDesktopShell) this.updates.openDesktopRelease();
    else void this.updates.reload();
  }
  protected readonly updates = inject(AppUpdates);
  protected readonly UpdateResult = UpdateCheckResult;
  protected readonly updateResult = signal<UpdateCheckResult | undefined>(undefined);
  protected readonly languageIcon = languageOutline;
  private readonly preferences = inject(Preferences);
  private readonly autoLabel = translateSignal('settings.language.auto');
  protected readonly localeLabel = computed(() => {
    const locale = this.preferences.selectedLocale();
    return locale ? localeLabels[locale] : this.autoLabel();
  });
  protected readonly generalIcon = chatbubblesOutline;

  protected readonly presenceIcon = eyeOutline;
  protected readonly notificationIcon = notificationsOutline;
  protected readonly updateIcon = refreshOutline;
  protected readonly devIcon = constructOutline;
  protected readonly devMode = isDevMode() && devBackendEnabled();
  protected readonly devUidInput = signal('');
  protected readonly devUidValid = computed(() => {
    const uid = Number(this.devUidInput());
    return Number.isInteger(uid) && uid > 0;
  });

  constructor() {
    if (this.devMode) this.devUidInput.set(String(this.session.devUid()));
  }

  protected editDevUid(event: Event) {
    this.devUidInput.set(String((event.target as HTMLIonInputElement).value ?? ''));
  }

  protected switchDevUid() {
    if (!this.devUidValid()) return;
    this.session.switchDevUid(Number(this.devUidInput()));
    window.location.reload();
  }

  protected close() {
    return this.panels.close();
  }

  protected async checkUpdates() {
    this.updateResult.set(undefined);
    this.updateResult.set(await this.updates.check());
  }
}
