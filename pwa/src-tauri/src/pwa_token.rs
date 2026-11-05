//! 读取浏览器 PWA 已保存的茶话登录态（Chromium Local Storage 明文 JWT）。
//!
//! Chromium 的 localStorage 不加密，值以 ASCII 明文躺在 leveldb 文件里；
//! 键形如 `_https://chahua.app\x00\x01jwt_token`，其后跟长度 varint + 类型字节 + 内容。
//! 本模块只读不写，遇锁文件跳过；返回全部候选 token，由前端按 iat 取最新并验活。

use std::fs;
use std::path::PathBuf;

use tauri::command;

const KEY: &[u8] = b"_https://chahua.app\x00\x01jwt_token";
/// leveldb 压缩（compaction）后键走前缀压缩，共享前缀被省略，只剩 `\x01jwt_token`。
/// 两种形态都要匹配，否则 Edge 一次 compaction 后就读不到（表现为时灵时不灵）。
const KEY_COMPACTED: &[u8] = b"\x01jwt_token";

fn browser_user_data_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        for vendor in [
            "Microsoft\\Edge",
            "Google\\Chrome",
            "BraveSoftware\\Brave-Browser",
        ] {
            roots.push(PathBuf::from(&local).join(vendor).join("User Data"));
        }
    }
    roots
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// 扫描各浏览器 profile 的 Local Storage，返回去重后的 JWT 候选列表。
/// 异步 + spawn_blocking：文件扫描不能占用主线程，否则 WebView 界面卡死。
#[command]
pub async fn read_pwa_jwt() -> Vec<String> {
    log::info!("[pwa_token] read_pwa_jwt invoked");
    let result = tauri::async_runtime::spawn_blocking(scan).await;
    match result {
        Ok(v) => {
            log::info!("[pwa_token] scan ok, candidates={}", v.len());
            v
        }
        Err(e) => {
            log::error!("[pwa_token] spawn_blocking join error: {e}");
            Vec::new()
        }
    }
}

/// 单个文件扫描上限：浏览器 leveldb 偶有大文件，超限跳过避免无谓 IO。
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

fn scan() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    for root in browser_user_data_roots() {
        let profiles = match fs::read_dir(&root) {
            Ok(p) => p,
            Err(_) => continue,
        };
        for profile in profiles.flatten() {
            let leveldb = profile.path().join("Local Storage").join("leveldb");
            if !leveldb.is_dir() {
                continue;
            }
            let entries = match fs::read_dir(&leveldb) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                match path.extension().and_then(|x| x.to_str()) {
                    Some("ldb") | Some("log") => {}
                    _ => continue,
                }
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if size > MAX_FILE_BYTES {
                    continue;
                }
                // Edge/Chrome 运行中个别文件可能独占：跳过即可，不视为失败
                let buf = match fs::read(&path) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                let mut cursor = 0usize;
                loop {
                    // 两种键形态取较先出现者（.log 未压缩 / .ldb 前缀压缩）
                    let next = match (find_sub(&buf[cursor..], KEY), find_sub(&buf[cursor..], KEY_COMPACTED)) {
                        (Some(a), Some(b)) => Some((a.min(b), if a <= b { KEY.len() } else { KEY_COMPACTED.len() })),
                        (Some(a), None) => Some((a, KEY.len())),
                        (None, Some(b)) => Some((b, KEY_COMPACTED.len())),
                        (None, None) => None,
                    };
                    let Some((rel, key_len)) = next else { break };
                    let value_start = cursor + rel + key_len;
                    // 布局无关提取：键与值之间隔着长度 varint / 类型标记等字节，
                    // 且长度字段本身可能是可打印字符（实测为 'G'），不能靠「跳过非打印字节」定位。
                    // 改为在键后 64 字节窗口内找 JWT 的固定前缀 eyJ。
                    const EYJ: &[u8] = b"eyJ";
                    let eyj = find_sub(&buf[value_start..value_start.saturating_add(64).min(buf.len())], EYJ);
                    let Some(eyj_rel) = eyj else {
                        cursor = value_start;
                        continue;
                    };
                    let mut j = value_start + eyj_rel;
                    while j < buf.len() && buf[j].is_ascii_graphic() {
                        j += 1;
                    }
                    let candidate = String::from_utf8_lossy(&buf[value_start + eyj_rel..j]).into_owned();
                    if candidate.len() > 60 && !out.contains(&candidate) {
                        out.push(candidate);
                    }
                    cursor = value_start;
                }
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::scan;
    use std::time::Instant;

    #[test]
    fn scan_timing_and_result() {
        let t = Instant::now();
        let v = scan();
        let ms = t.elapsed().as_millis();
        println!("SCAN_MS={ms} CANDIDATES={}", v.len());
        for c in &v {
            println!("  len={} head={}****", c.len(), &c[..24.min(c.len())]);
        }
        assert!(ms < 10_000, "scan too slow: {ms}ms");
    }
}
