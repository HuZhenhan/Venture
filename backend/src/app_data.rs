use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::config::app_data_dir;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    pub language: String,
    pub send_shortcut: bool,
    pub auto_generate_conversation_titles: bool,
    pub auto_generate_reasoning_titles: bool,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            language: "简体中文".to_string(),
            send_shortcut: true,
            auto_generate_conversation_titles: true,
            auto_generate_reasoning_titles: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDataFile {
    #[serde(default)]
    pub chats: Vec<Value>,
    #[serde(default)]
    pub active_chat_id: Option<String>,
    #[serde(default)]
    pub preferences: AppPreferences,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub updated_at: u64,
}

impl Default for AppDataFile {
    fn default() -> Self {
        Self {
            chats: Vec::new(),
            active_chat_id: None,
            preferences: AppPreferences::default(),
            theme: default_theme(),
            updated_at: now_secs(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDataPatch {
    pub chats: Option<Vec<Value>>,
    pub active_chat_id: Option<Option<String>>,
    pub preferences: Option<AppPreferences>,
    pub theme: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateAppDataRequest {
    pub source: AppDataPatch,
}

pub struct AppDataStore {
    data_path: PathBuf,
    state: Arc<RwLock<AppDataFile>>,
    persist_lock: tokio::sync::Mutex<()>,
}

fn default_theme() -> String {
    "system".to_string()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl AppDataStore {
    pub async fn load() -> Result<Self> {
        let data_dir = app_data_dir()?;
        std::fs::create_dir_all(&data_dir).context("create app data dir")?;
        let data_path = data_dir.join("app-data.json");
        let state = if data_path.exists() {
            match std::fs::read(&data_path) {
                Ok(raw) => match serde_json::from_slice::<AppDataFile>(&raw) {
                    Ok(mut data) => {
                        if data.updated_at == 0 {
                            data.updated_at = now_secs();
                        }
                        data
                    }
                    Err(error) => {
                        backup_corrupted_app_data(&data_path);
                        tracing::error!("app data parse failed: {error}; original file has been backed up");
                        AppDataFile::default()
                    }
                },
                Err(error) => {
                    tracing::error!("read app data failed: {error}");
                    AppDataFile::default()
                }
            }
        } else {
            AppDataFile::default()
        };

        Ok(Self {
            data_path,
            state: Arc::new(RwLock::new(state)),
            persist_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub async fn get(&self) -> AppDataFile {
        self.state.read().await.clone()
    }

    pub async fn replace(&self, mut data: AppDataFile) -> Result<AppDataFile, AppError> {
        data.updated_at = now_secs();
        {
            let mut state = self.state.write().await;
            *state = data.clone();
        }
        self.persist().await?;
        Ok(data)
    }

    pub async fn patch(&self, patch: AppDataPatch) -> Result<AppDataFile, AppError> {
        let next = {
            let mut state = self.state.write().await;
            apply_patch(&mut state, patch);
            state.updated_at = now_secs();
            state.clone()
        };
        self.persist().await?;
        Ok(next)
    }

    pub async fn migrate(&self, request: MigrateAppDataRequest) -> Result<AppDataFile, AppError> {
        let next = {
            let mut state = self.state.write().await;
            if let Some(chats) = request.source.chats {
                merge_chats(&mut state.chats, chats);
            }
            if let Some(active_chat_id) = request.source.active_chat_id {
                state.active_chat_id = active_chat_id;
            }
            if let Some(preferences) = request.source.preferences {
                state.preferences = preferences;
            }
            if let Some(theme) = request.source.theme {
                state.theme = theme;
            }
            state.updated_at = now_secs();
            state.clone()
        };
        self.persist().await?;
        Ok(next)
    }

    async fn persist(&self) -> Result<(), AppError> {
        let _guard = self.persist_lock.lock().await;
        let bytes = {
            let state = self.state.read().await;
            serde_json::to_vec_pretty(&*state)
                .map_err(|e| AppError::ConfigWriteFailed(e.to_string()))?
        };
        let tmp_path = self.data_path.with_file_name(format!(
            "app-data.json.{}.{}.tmp",
            std::process::id(),
            &Uuid::new_v4().to_string()[..8]
        ));
        tokio::fs::write(&tmp_path, bytes)
            .await
            .map_err(|e| AppError::ConfigWriteFailed(e.to_string()))?;
        tokio::fs::rename(&tmp_path, &self.data_path)
            .await
            .map_err(|e| AppError::ConfigWriteFailed(e.to_string()))?;
        Ok(())
    }
}

fn apply_patch(state: &mut AppDataFile, patch: AppDataPatch) {
    if let Some(chats) = patch.chats {
        state.chats = chats;
    }
    if let Some(active_chat_id) = patch.active_chat_id {
        state.active_chat_id = active_chat_id;
    }
    if let Some(preferences) = patch.preferences {
        state.preferences = preferences;
    }
    if let Some(theme) = patch.theme {
        state.theme = theme;
    }
}

fn merge_chats(existing: &mut Vec<Value>, incoming: Vec<Value>) {
    for incoming_chat in incoming {
        let Some(incoming_id) = chat_id(&incoming_chat) else {
            existing.insert(0, incoming_chat);
            continue;
        };
        if let Some(existing_chat) = existing.iter_mut().find(|chat| chat_id(chat).as_deref() == Some(&incoming_id)) {
            *existing_chat = incoming_chat;
        } else {
            existing.insert(0, incoming_chat);
        }
    }
}

fn chat_id(chat: &Value) -> Option<String> {
    chat.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn backup_corrupted_app_data(path: &PathBuf) {
    let backup = path.with_file_name(format!("app-data.json.corrupt.{}.bak", now_secs()));
    if let Err(error) = std::fs::rename(path, &backup) {
        tracing::error!("failed to backup corrupted app data: {error}");
    } else {
        tracing::warn!("corrupted app data backed up to: {}", backup.display());
    }
}
