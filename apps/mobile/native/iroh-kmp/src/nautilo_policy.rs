//! App-private JNI policy hook; the upstream UniFFI ABI remains unchanged.
use std::sync::{Arc, LazyLock, atomic::{AtomicBool, Ordering}};

// Fail closed until the authenticated policy datagram has been read.
static DIRECT_ONLY: LazyLock<Arc<AtomicBool>> = LazyLock::new(|| Arc::new(AtomicBool::new(true)));

pub(crate) fn required() -> Arc<AtomicBool> { DIRECT_ONLY.clone() }

#[no_mangle]
pub extern "C" fn nautilo_iroh_direct_only(enabled: bool) {
    DIRECT_ONLY.store(enabled, Ordering::Release);
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_nautilo_mobile_transport_DirectTransportPolicy_setEnabledNative(
    _env: *mut std::ffi::c_void, _object: *mut std::ffi::c_void, enabled: u8,
) {
    nautilo_iroh_direct_only(enabled != 0);
}
