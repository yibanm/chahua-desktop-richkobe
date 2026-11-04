use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

/// 授权窗口标签：同一时刻只允许一个。
const AUTH_LABEL: &str = "auth";

/// 捕获 token 的回调目标 host：只有导航到应用自身域名且带 token 时才采纳。
fn token_from_url(url: &url::Url) -> Option<String> {
    let host = url.host_str()?;
    if !(host == "chahua.app" || host.ends_with(".chahua.app") || host == "chahui.app" || host.ends_with(".chahui.app"))
    {
        return None;
    }
    url.query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())
        .filter(|t| !t.is_empty())
}

/// 打开官方论坛授权窗口。
///
/// 用户在窗口内自行登录官方论坛并点击帖子中的入口链接；论坛会把带 token 的
/// 重定向指向 chahua.app。本命令在导航到该地址的瞬间捕获 token、阻止页面继续
/// 加载（避免授权窗口变成第二个应用实例）、向主窗口发事件并关闭授权窗口。
/// 全程不接触用户密码，凭证来源与 PWA 读地址栏完全同源。
#[tauri::command]
pub fn open_auth_window(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("only https entry urls are allowed".into());
    }
    // 入口本身已带 token 时无需开窗，直接交给前端采纳
    if let Some(token) = token_from_url(&parsed) {
        app.emit("auth-token", token).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if let Some(existing) = app.get_webview_window(AUTH_LABEL) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let handle = app.clone();
    WebviewWindowBuilder::new(&app, AUTH_LABEL, tauri::WebviewUrl::External(parsed))
        .title("茶话登录授权")
        .inner_size(480.0, 720.0)
        .on_navigation(move |target| {
            if let Some(token) = token_from_url(target) {
                let _ = handle.emit("auth-token", token);
                if let Some(w) = handle.get_webview_window(AUTH_LABEL) {
                    let _ = w.close();
                }
                // 阻止导航：授权窗口不应加载应用本体
                return false;
            }
            true
        })
        .build()
        .map_err(|e| format!("open auth window failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::token_from_url;

    #[test]
    fn captures_token_on_official_hosts() {
        let url = url::Url::parse("https://chahua.app/chats?token=abc123").unwrap();
        assert_eq!(token_from_url(&url).as_deref(), Some("abc123"));
        let url = url::Url::parse("https://chahui.app/chats?join=x&token=abc123").unwrap();
        assert_eq!(token_from_url(&url).as_deref(), Some("abc123"));
    }

    #[test]
    fn rejects_other_hosts_even_with_token_param() {
        // Security-critical: never capture a token from a non-chahua host,
        // otherwise a phishing site reached from the auth window could inject one.
        let url = url::Url::parse("https://evil.example.com/?token=abc123").unwrap();
        assert_eq!(token_from_url(&url), None);
        // Suffix matching must respect domain boundaries: chahua.app.evil.com is not official.
        let url = url::Url::parse("https://chahua.app.evil.com/?token=abc123").unwrap();
        assert_eq!(token_from_url(&url), None);
    }

    #[test]
    fn rejects_empty_token_and_missing_param() {
        let url = url::Url::parse("https://chahua.app/chats?token=").unwrap();
        assert_eq!(token_from_url(&url), None);
        let url = url::Url::parse("https://chahua.app/chats").unwrap();
        assert_eq!(token_from_url(&url), None);
    }
}
