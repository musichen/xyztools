fn main() {
    tauri_build::build();
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let target = std::env::var("TARGET").expect("TARGET must be set by Cargo");
    std::fs::write(out_dir.join("target_triple.txt"), target.as_bytes()).expect("write target_triple");
    println!("cargo:rerun-if-changed=build.rs");
}
