import { afterRenderEffect, Component, DestroyRef, inject, signal, viewChild } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToast,
  IonToggle,
  IonToolbar,
} from '@ionic/angular';
import type { ToggleCustomEvent } from '@ionic/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { chevronBackOutline, notificationsOutline, refreshOutline } from 'ionicons/icons';
import { GroupKind } from '../../../generated/models';
import { ChatStore } from '../../chats/chat-store';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { PushNotificationError, PushNotifications } from '../../pwa/push-notifications';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { isTauri } from '../../tauri/tauri-runtime';
import { NotificationCategory } from './notification-category';

@Component({
  selector: 'app-notification-settings',
  templateUrl: './notification-settings.html',
  imports: [
    ContentScrollbars,
    NotificationCategory,
    TranslocoPipe,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonList,
    IonListHeader,
    IonLabel,
    IonNote,
    IonSpinner,
    IonTitle,
    IonToast,
    IonToggle,
    IonToolbar,
  ],
  host: { class: 'ion-page' },
})
export class NotificationSettings {
  protected readonly store = inject(ChatStore);
  protected readonly Kind = GroupKind;
  protected readonly panels = inject(PanelNavigation);
  protected readonly notifications = inject(PushNotifications);
  protected readonly PushError = PushNotificationError;
  protected readonly backIcon = chevronBackOutline;
  protected readonly updateIcon = refreshOutline;
  protected readonly notificationIcon = notificationsOutline;
  // 桌面壳与浏览器的权限修复指引不同：壳内要去 Windows 系统设置里放行
  protected readonly isDesktopShell = isTauri();
  protected readonly testing = signal(false);
  private readonly transloco = inject(TranslocoService);
  private readonly permissionToast = viewChild.required(IonToast);

  constructor() {
    const refresh = () => {
      if (!document.hidden) void this.notifications.refresh();
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    });
    afterRenderEffect(() => {
      if (this.notifications.error() === PushNotificationError.PermissionDenied) void this.permissionToast().present();
    });
  }

  protected retry() {
    return this.notifications.setEnabled(this.notifications.enabled());
  }

  /** 发送测试通知：绕开消息判定直接投递，失败时复用权限被拒的提示。 */
  protected async sendTest() {
    this.testing.set(true);
    const ok = await this.notifications.testNotify(
      this.transloco.translate('settings.menu.testNotificationTitle'),
      this.transloco.translate('settings.menu.testNotificationBody'),
    );
    this.testing.set(false);
    if (!ok) void this.permissionToast().present();
  }

  protected async setNotifications(event: ToggleCustomEvent) {
    await this.notifications.setEnabled(event.detail.checked);
    event.target.checked = this.notifications.enabled();
  }
}
