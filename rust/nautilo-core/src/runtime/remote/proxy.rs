//! Proxy only HTTP(S) discovery/rendezvous. QUIC IP paths stay on native UDP.
use super::Settings;
use reqwest::Url;

pub(super) fn configured(settings: &Settings) -> Option<(Url, &'static str)> {
    if settings.relay_mode == "lan" { return None; }
    for name in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(value) = std::env::var(name) {
            if let Some(url) = http_proxy(&value) { return Some((url, "environment")); }
        }
    }
    // A single iroh proxy applies to every service. Do not override custom
    // relay routing with a system-wide rule; explicit environment config works.
    if uses_public_services(settings) {
        if let Some(url) = system_proxy() { return Some((url, "system")); }
    }
    None
}

fn uses_public_services(settings: &Settings) -> bool {
    if !matches!(settings.relay_mode.as_str(), "custom" | "direct") { return true; }
    use iroh::defaults::prod::{AP_RELAY_HOSTNAME, EU_RELAY_HOSTNAME, NA_EAST_RELAY_HOSTNAME, NA_WEST_RELAY_HOSTNAME};
    settings.relay_urls.iter().all(|value| {
        Url::parse(value).ok().and_then(|url| url.host_str().map(str::to_owned)).is_some_and(|host| {
            [AP_RELAY_HOSTNAME, EU_RELAY_HOSTNAME, NA_EAST_RELAY_HOSTNAME, NA_WEST_RELAY_HOSTNAME]
                .iter().any(|expected| host.trim_end_matches('.') == expected.trim_end_matches('.'))
        })
    })
}

fn http_proxy(value: &str) -> Option<Url> {
    let value = value.trim();
    if value.is_empty() { return None; }
    let url: Url = if value.contains("://") { value.parse().ok()? }
        else { format!("http://{value}").parse().ok()? };
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
        && url.path() == "/" && url.query().is_none() && url.fragment().is_none()).then_some(url)
}

fn windows_https_proxy(value: &str) -> Option<Url> {
    if !value.contains('=') { return http_proxy(value); }
    // Windows uses "https=host:port" to select the proxy for HTTPS targets;
    // it does not imply TLS to the proxy itself.
    value.split(';').find_map(|entry| {
        let (scheme, address) = entry.trim().split_once('=')?;
        scheme.eq_ignore_ascii_case("https").then(|| http_proxy(address)).flatten()
    })
}

#[cfg(not(windows))]
fn system_proxy() -> Option<Url> { None }

#[cfg(windows)]
fn system_proxy() -> Option<Url> {
    use std::{ffi::c_void, ptr};
    #[repr(C)]
    struct Config { auto_detect: i32, auto_url: *mut u16, proxy: *mut u16, bypass: *mut u16 }
    #[link(name = "winhttp")]
    extern "system" { fn WinHttpGetIEProxyConfigForCurrentUser(config: *mut Config) -> i32; }
    #[link(name = "kernel32")]
    extern "system" { fn GlobalFree(pointer: *mut c_void) -> *mut c_void; }
    impl Drop for Config {
        fn drop(&mut self) {
            for pointer in [self.auto_url, self.proxy, self.bypass] {
                if !pointer.is_null() { unsafe { GlobalFree(pointer.cast()); } }
            }
        }
    }
    unsafe fn text(pointer: *const u16) -> String {
        if pointer.is_null() { return String::new(); }
        // WinHTTP owns a null-terminated UTF-16 allocation, freed by Config.
        let mut length = 0;
        while *pointer.add(length) != 0 { length += 1; }
        String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
    }
    let mut config = Config { auto_detect: 0, auto_url: ptr::null_mut(), proxy: ptr::null_mut(), bypass: ptr::null_mut() };
    if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) } == 0 { return None; }
    // PAC is per URL and cannot be represented by iroh's one static proxy.
    if !unsafe { text(config.auto_url) }.is_empty() { return None; }
    let bypass = unsafe { text(config.bypass) };
    // Respect explicit exclusions of the default discovery/relay domains.
    // Common private-network bypass entries do not match these public services.
    use iroh::defaults::prod::{AP_RELAY_HOSTNAME, EU_RELAY_HOSTNAME, NA_EAST_RELAY_HOSTNAME, NA_WEST_RELAY_HOSTNAME};
    let default_hosts = [iroh::address_lookup::dns::N0_DNS_ENDPOINT_ORIGIN_PROD,
        AP_RELAY_HOSTNAME, NA_EAST_RELAY_HOSTNAME, NA_WEST_RELAY_HOSTNAME, EU_RELAY_HOSTNAME];
    if default_hosts.iter().any(|host| bypasses(&bypass, host)) { return None; }
    windows_https_proxy(&unsafe { text(config.proxy) })
}

fn bypasses(list: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    list.split(';').any(|pattern| {
        let pattern = pattern.trim().to_ascii_lowercase();
        if pattern == "<local>" { return !host.contains('.'); }
        if pattern.is_empty() { return false; }
        // Windows host wildcards; match the whole hostname, never a substring.
        let (mut p, mut h, mut star, mut resume) = (0, 0, None, 0);
        let pattern = pattern.as_bytes(); let host = host.as_bytes();
        while h < host.len() {
            if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == host[h]) { p += 1; h += 1; }
            else if p < pattern.len() && pattern[p] == b'*' { star = Some(p); p += 1; resume = h; }
            else if let Some(index) = star { resume += 1; h = resume; p = index + 1; }
            else { return false; }
        }
        while p < pattern.len() && pattern[p] == b'*' { p += 1; }
        p == pattern.len()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_singapore_node_keeps_system_proxy_and_dormant_nodes_do_not_override_it() {
        let mut settings = Settings::default();
        settings.relay_mode = "custom".into();
        assert!(uses_public_services(&settings));
        settings.relay_urls = vec!["https://aps1-1.relay.n0.iroh.link./".into()];
        assert!(uses_public_services(&settings));
        settings.relay_urls = vec!["https://private-relay.example.com".into()];
        assert!(!uses_public_services(&settings));
        settings.relay_mode = "automatic".into();
        assert!(uses_public_services(&settings));
    }
    #[test]
    fn windows_proxy_protocol_map_does_not_turn_connect_into_tls() {
        assert_eq!(windows_https_proxy("127.0.0.1:17890").unwrap().as_str(), "http://127.0.0.1:17890/");
        assert_eq!(windows_https_proxy("http=one:80;https=two:8080;socks=three:1080").unwrap().as_str(), "http://two:8080/");
        assert!(windows_https_proxy("http=one:80;socks=three:1080").is_none());
        assert!(http_proxy("socks5://localhost:1080").is_none());
        assert!(http_proxy("http://localhost:8080/path").is_none());
    }
    #[test]
    fn system_bypass_keeps_explicit_public_service_exclusions() {
        assert!(!bypasses("<local>;localhost;127.*;10.*;192.168.*", "aps1-1.relay.n0.iroh.link"));
        assert!(bypasses("*.iroh.link", "aps1-1.relay.n0.iroh.link."));
        assert!(bypasses("dns.iroh.link", "dns.iroh.link"));
        assert!(!bypasses("dns.iroh.link", "other.dns.iroh.link"));
    }
}
