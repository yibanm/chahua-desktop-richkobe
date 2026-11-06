use tauri::Manager;

/// 前端日志落盘通道：@tauri-apps/plugin-log 的前端 info/error 在本壳内未落到文件
/// （实测 b9 启动后日志无任何新行），改用自定义命令走 Rust 侧 log 宏——
/// 与 pwa_token 同一通道，已证实可写入 %LOCALAPPDATA%/.../logs/茶话.log。
/// 自定义应用命令不需要 capabilities 权限条目。
/// 双保险：同时用 std::fs 直追加到 ASCII 文件名的 weblog.txt——
/// 日志插件的中文文件名/轮转若再出问题，这条通道仍保证落盘（b10 实测日志零新行后加）。
#[tauri::command]
fn frontend_log(app: tauri::AppHandle, level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[web] {message}"),
        "warn" => log::warn!("[web] {message}"),
        _ => log::info!("[web] {message}"),
    }
    append_weblog(&app, &format!("[{level}] {message}"));
}

fn append_weblog(app: &tauri::AppHandle, line: &str) {
    use std::io::Write;
    // epoch 秒时间戳：实测低内存机器上日志写入延迟可达数十秒，无时间戳无法判断事件真实顺序。
    // 读日志时再换算成可读时间（日志读者是 AI/开发者，不是用户）。
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("weblog.txt")) {
        let _ = writeln!(f, "[{ts}] {line}");
    }
}

#[cfg(not(mobile))]
mod pwa_token;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 诊断行：不依赖前端/IPC/插件顺序，run() 一进就写。若日志里连这行都没有，
    // 说明 tauri-plugin-log 的文件通道本身坏了（而非前端调用链问题）。
    // 注意：此行在 log 插件注册之前执行，可能不进文件——故 setup 内再补一行。
    log::info!("[rust] run() entered");
    // 绕开系统代理（本机 127.0.0.1:7897 间歇性卡顿会挂死整壳请求，实测直连中位 406ms/0 失败、
    // 走代理中位 1.8s 有尖刺）。reqwest 的系统代理匹配器读 NO_PROXY 环境变量，"*" 排除全部域名=直连。
    // 必须在任何插件/请求之前设置。壳内访问域均实测直连可达；论坛域只经系统浏览器，不经壳。
    std::env::set_var("NO_PROXY", "*");
    std::env::set_var("no_proxy", "*");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // release 也落盘日志：用户反馈问题时可直接提供日志文件定位
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            log::info!("[rust] log plugin registered in setup");
            Ok(())
        });
    // 桌面专属：单实例、窗口状态、读浏览器登录态（扫 Windows 路径，移动端无意义）
    #[cfg(not(mobile))]
    let builder = builder
        .invoke_handler(tauri::generate_handler![pwa_token::read_pwa_jwt, frontend_log])
        // 单实例必须最先注册：第二个实例启动时把焦点交回已有窗口后直接退出。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build());
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![frontend_log]);
    builder
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
