use std::fs;
use std::path::PathBuf;

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// Open a native file picker. Returns the absolute path, or None if cancelled.
#[tauri::command]
async fn pick_pdf(app: tauri::AppHandle) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_title("Open a PDF")
        .blocking_pick_file();

    picked
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// A PDF path passed on the command line (`zone paper.pdf`), if any. This is
/// also where a macOS "Open With" hand-off will land once the bundle declares
/// a file association.
#[tauri::command]
fn initial_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| a.to_lowercase().ends_with(".pdf") && PathBuf::from(a).is_file())
}

/// Read a file as raw bytes. Returned via `tauri::ipc::Response` so the bytes
/// travel as a binary payload instead of a JSON number array.
#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

/// Webview breadcrumbs to stderr. The OS WebView's console is not reachable
/// from a terminal, so dev builds forward errors here (see src/main.tsx).
#[tauri::command]
fn dbg(msg: String) {
    eprintln!("[web] {msg}");
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    Ok(dir.join("library.json"))
}

/// Load the persisted library blob. The frontend owns the schema; this is an
/// opaque string as far as Rust is concerned.
#[tauri::command]
fn load_state(app: tauri::AppHandle) -> Result<String, String> {
    let path = state_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => Err(format!("{path:?}: {e}")),
    }
}

#[tauri::command]
fn save_state(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = state_path(&app)?;
    // Write-then-rename so a crash mid-write can't truncate the library.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("{tmp:?}: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("{path:?}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            pick_pdf,
            initial_path,
            read_file,
            dbg,
            load_state,
            save_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
