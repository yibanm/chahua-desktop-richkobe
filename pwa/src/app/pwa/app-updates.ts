import { computed, inject, Injector, InjectionToken, isDevMode, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate } from '@angular/service-worker';
import { firstValueFrom, from, map, of, ReplaySubject, switchMap, timeout } from 'rxjs';
import { AlertController } from '@ionic/angular';
import { TranslocoService } from '@jsverse/transloco';
import { MessageOutbox } from '../messages/message-outbox';
import { MessageDelivery } from '../messages/message-delivery';
import { appVersion } from '../app-version';
import { desktopAppVersion, fetchDesktopUpdateInfo, isTauri, openExternalUrl } from '../tauri/tauri-runtime';

export enum UpdateCheckResult {
  Updated = 'updated',
  Current = 'current',
  Unavailable = 'unavailable',
  Failed = 'failed',
}

export const APP_UPDATES_ENABLED = new InjectionToken<boolean>('APP_UPDATES_ENABLED', {
  providedIn: 'root',
  factory: () => !isDevMode(),
});

@Service()
export class AppUpdates {
  private readonly updates = inject(SwUpdate);
  private readonly injector = inject(Injector);
  private confirmingReload = false;
  private readonly checkingState = signal(false);
  private readonly availableState = signal(false);
  private readonly latestVersion = signal(window.chahuaUpdates?.latestVersion);
  private readonly dismissedVersion = signal<string | undefined>(undefined);
  private readonly interactive = signal(false);
  // 桌面壳没有 SW：更新信息来自仓库里的 version.json，新版本号与下载地址存这里
  private readonly desktopUpdate = signal<{ version: string; releaseUrl: string; downloadUrl?: string } | undefined>(
    undefined,
  );
  private pendingCheck?: Promise<UpdateCheckResult>;
  private download?: { hash: string; ready: ReplaySubject<boolean> };
  readonly supported = inject(APP_UPDATES_ENABLED) && (isTauri() || this.updates.isEnabled);
  // 桌面壳构建期没有注入 CHAHUA_APP_VERSION（appVersion 是占位串 PWA2-dev），
  // 故版本号改由 Tauri 运行时读取，与 tauri.conf.json 同源，避免两处版本号漂移。
  private readonly versionState = signal(appVersion);
  readonly version = this.versionState.asReadonly();
  readonly checking = this.checkingState.asReadonly();
  readonly available = computed(() => this.availableState() || !!this.latestVersion() || !!this.desktopUpdate());
  readonly promptOpen = computed(
    () => this.interactive() && !!this.latestVersion() && this.latestVersion() !== this.dismissedVersion(),
  );

  constructor() {
    if (isTauri()) void desktopAppVersion().then((v) => v && this.versionState.set(v));
    this.updates.versionUpdates.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === 'VERSION_DETECTED' && event.version.hash !== this.download?.hash) {
        this.download?.ready.next(false);
        this.download = { hash: event.version.hash, ready: new ReplaySubject<boolean>(1) };
      } else if (event.type === 'VERSION_READY') {
        this.latestVersion.set(event.latestVersion.hash);
        this.download?.ready.next(true);
        this.download = undefined;
      } else if (event.type === 'VERSION_INSTALLATION_FAILED' && event.version.hash === this.download?.hash) {
        this.download.ready.next(false);
        this.download = undefined;
      }
    });
  }

  setInteractive(value: boolean) {
    this.interactive.set(value);
    window.chahuaUpdates?.setInteractive(value);
  }

  readonly dismiss = () => this.dismissedVersion.set(this.latestVersion());

  check(): Promise<UpdateCheckResult> {
    if (!this.supported) return Promise.resolve(UpdateCheckResult.Unavailable);
    if (this.pendingCheck) return this.pendingCheck;
    this.checkingState.set(true);
    this.pendingCheck = (isTauri() ? this.checkDesktopUpdate() : this.checkForUpdate()).finally(() => {
      this.checkingState.set(false);
      this.pendingCheck = undefined;
    });
    return this.pendingCheck;
  }

  /**
   * 桌面壳更新检查：读仓库里的 version.json 比版本号，有新版就记下 Release 页地址。
   * 为什么不用 GitHub API：镜像不能代理 api.github.com（实测 ghfast/ghproxy 均 403，仅直连 200），
   * 而 raw 文件走镜像可达（实测 200），故版本信息放仓库文件、下载走镜像。
   */
  private async checkDesktopUpdate(): Promise<UpdateCheckResult> {
    this.desktopUpdate.set(undefined);
    try {
      const info = await fetchDesktopUpdateInfo(this.version());
      if (!info) return UpdateCheckResult.Current;
      this.desktopUpdate.set(info);
      return UpdateCheckResult.Updated;
    } catch {
      return UpdateCheckResult.Failed;
    }
  }

  /** 桌面壳「立即更新」：优先镜像直连安装包（国内可达），无则 Release 页；壳内不能自替换 exe。 */
  readonly openDesktopRelease = () => {
    const update = this.desktopUpdate();
    if (!update) return;
    void openExternalUrl(update.downloadUrl ?? update.releaseUrl).catch(() => {});
  };

  readonly reload = async () => {
    if (this.confirmingReload) return;
    const unfinished = this.injector
      .get(MessageOutbox)
      .items()
      .some((item) => !item.cancelled() && item.delivery() !== MessageDelivery.Sent);
    if (unfinished) {
      this.confirmingReload = true;
      try {
        const text = this.injector.get(TranslocoService);
        const alert = await this.injector.get(AlertController).create({
          header: text.translate('app.updateNow'),
          message: text.translate('app.updatePendingMessages'),
          buttons: [
            { text: text.translate('app.updateLater'), role: 'cancel' },
            { text: text.translate('app.updateAnyway'), role: 'destructive' },
          ],
        });
        await alert.present();
        if ((await alert.onDidDismiss()).role !== 'destructive') return;
      } finally {
        this.confirmingReload = false;
      }
    }
    window.location.reload();
  };

  private async checkForUpdate(): Promise<UpdateCheckResult> {
    let confirmedCurrent = false;
    let failed = false;
    const subscription = this.updates.versionUpdates.subscribe((event) => {
      if (event.type === 'NO_NEW_VERSION_DETECTED') confirmedCurrent = true;
      if (event.type === 'VERSION_INSTALLATION_FAILED') failed = true;
    });
    try {
      return await firstValueFrom(
        from(this.updates.checkForUpdate()).pipe(
          switchMap((downloaded) => {
            if (downloaded) this.availableState.set(true);
            return this.download?.ready ?? of(true);
          }),
          map((ready) => {
            if (!ready) return UpdateCheckResult.Failed;
            // The early listener can receive readiness before Angular subscribes.
            const earlyVersion = window.chahuaUpdates?.latestVersion;
            if (earlyVersion) this.latestVersion.set(earlyVersion);
            if (this.available()) return UpdateCheckResult.Updated;
            return confirmedCurrent && !failed ? UpdateCheckResult.Current : UpdateCheckResult.Failed;
          }),
          timeout(15000),
        ),
      );
    } catch {
      return UpdateCheckResult.Failed;
    } finally {
      subscription.unsubscribe();
    }
  }
}
