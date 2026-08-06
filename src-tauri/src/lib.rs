use tauri::Manager;

/// 前端“退出确认弹窗”确认后调用，真正退出应用。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![quit_app])
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
