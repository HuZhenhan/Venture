#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            let backend_data_dir = data_dir.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = venture_backend::run_server(Some(backend_data_dir)).await {
                    tracing::error!("backend server error: {e}");
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run failed");
}
