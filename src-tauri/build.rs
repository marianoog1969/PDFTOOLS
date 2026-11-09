fn main() {
    // `capi_check` permite compilar el código de CryptoAPI fuera de Windows para revisarlo; se declara para que rustc no avise.
    println!("cargo::rustc-check-cfg=cfg(capi_check)");
    tauri_build::build()
}
