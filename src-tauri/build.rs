fn main() {
    println!("cargo:rerun-if-changed=build-metadata.env");
    if let Ok(contents) = std::fs::read_to_string("build-metadata.env") {
        for line in contents.lines() {
            if let Some((key, value)) = line.split_once('=') {
                println!("cargo:rustc-env={key}={value}");
            }
        }
    }
    tauri_build::build()
}
