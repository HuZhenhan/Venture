use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use anyhow::{Context, Result};
use uuid::Uuid;
use directories::ProjectDirs;
use url::Url;

use crate::crypto::{decrypt, derive_or_create_key, encrypt};
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    #[serde(default)]
    pub supports_multimodal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRecord {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<ModelEntry>,
    #[serde(default = "default_input_context_window")]
    pub input_context_window: u32,
    #[serde(default = "default_output_context_window")]
    pub output_context_window: u32,
}

fn default_input_context_window() -> u32 {
    20
}

fn default_output_context_window() -> u32 {
    4096
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPublic {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub has_api_key: bool,
    pub api_key_preview: String,
    pub models: Vec<ModelEntry>,
    pub input_context_window: u32,
    pub output_context_window: u32,
}

impl From<&ProviderRecord> for ProviderPublic {
    fn from(r: &ProviderRecord) -> Self {
        // 使用 chars() 保证 UTF-8 边界安全，不会在中文/emoji 中间切断
        let chars: Vec<char> = r.api_key.chars().collect();
        let preview = if chars.len() >= 8 {
            let start: String = chars[..4].iter().collect();
            let end: String = chars[chars.len() - 4..].iter().collect();
            format!("{}****{}", start, end)
        } else if !r.api_key.is_empty() {
            "****".to_string()
        } else {
            String::new()
        };
        ProviderPublic {
            id: r.id.clone(),
            name: r.name.clone(),
            base_url: r.base_url.clone(),
            has_api_key: !r.api_key.is_empty(),
            api_key_preview: preview,
            models: r.models.clone(),
            input_context_window: r.input_context_window,
            output_context_window: r.output_context_window,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ConfigFile {
    #[serde(default)]
    providers: Vec<ProviderRecord>,
}

pub struct ConfigStore {
    key: [u8; 32],
    config_path: PathBuf,
    state: Arc<RwLock<ConfigFile>>,
    persist_lock: tokio::sync::Mutex<()>,
}

pub(crate) fn app_data_dir() -> Result<PathBuf> {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return Ok(PathBuf::from(appdata).join("Venture"));
    }
    let proj = ProjectDirs::from("com", "venture", "Venture")
        .context("cannot determine project dirs")?;
    Ok(proj.data_dir().to_path_buf())
}

fn legacy_app_data_dir() -> Result<PathBuf> {
    let proj = ProjectDirs::from("com", "venture", "Venture")
        .context("cannot determine project dirs")?;
    Ok(proj.data_local_dir().to_path_buf())
}

fn migrate_legacy_config(data_dir: &PathBuf) {
    let Ok(legacy_dir) = legacy_app_data_dir() else {
        return;
    };
    if legacy_dir == *data_dir {
        return;
    }

    let target_key = data_dir.join("venture.key");
    let target_config = data_dir.join("config.enc");
    if target_key.exists() || target_config.exists() {
        return;
    }

    for file_name in ["venture.key", "config.enc"] {
        let source = legacy_dir.join(file_name);
        let target = data_dir.join(file_name);
        if !source.exists() {
            return;
        }
        if let Err(error) = std::fs::copy(&source, &target) {
            tracing::warn!("failed to migrate legacy config {}: {error}", source.display());
            return;
        }
        tracing::info!("migrated legacy config {} to {}", source.display(), target.display());
    }
}

fn read_encrypted_config(key_path: &PathBuf, config_path: &PathBuf) -> Option<ConfigFile> {
    if !key_path.exists() || !config_path.exists() {
        return None;
    }
    let key = match derive_or_create_key(key_path) {
        Ok(key) => key,
        Err(error) => {
            tracing::warn!("failed to read config key {}: {error}", key_path.display());
            return None;
        }
    };
    let raw = match std::fs::read(config_path) {
        Ok(raw) => raw,
        Err(error) => {
            tracing::warn!("failed to read config {}: {error}", config_path.display());
            return None;
        }
    };
    match decrypt(&key, &raw)
        .ok()
        .and_then(|plain| serde_json::from_slice::<ConfigFile>(&plain).ok())
    {
        Some(config) => Some(config),
        None => {
            tracing::warn!("failed to decrypt or parse legacy config {}", config_path.display());
            None
        }
    }
}

fn merge_legacy_provider_config(state: &mut ConfigFile, data_dir: &PathBuf) -> bool {
    let Ok(legacy_dir) = legacy_app_data_dir() else {
        return false;
    };
    if legacy_dir == *data_dir {
        return false;
    }
    let Some(legacy_config) = read_encrypted_config(
        &legacy_dir.join("venture.key"),
        &legacy_dir.join("config.enc"),
    ) else {
        return false;
    };

    let mut changed = false;
    for legacy_provider in legacy_config.providers {
        if let Some(current) = state.providers.iter_mut().find(|provider| {
            provider.id == legacy_provider.id
                || (provider.name == legacy_provider.name && provider.base_url == legacy_provider.base_url)
        }) {
            if current.api_key.is_empty() && !legacy_provider.api_key.is_empty() {
                current.api_key = legacy_provider.api_key.clone();
                changed = true;
            }
            for legacy_model in legacy_provider.models {
                if !current.models.iter().any(|model| model.id == legacy_model.id) {
                    current.models.push(legacy_model);
                    changed = true;
                }
            }
        } else {
            state.providers.push(legacy_provider);
            changed = true;
        }
    }
    changed
}

/// Provider config 校验：URL、模型、上下文窗口均需合法
fn validate_provider_input(
    base_url: &str,
    models: &[ModelEntry],
    input_context_window: u32,
    output_context_window: u32,
) -> Result<(), AppError> {
    if base_url.trim().is_empty() {
        return Err(AppError::InvalidProviderConfig("base_url is required".into()));
    }
    let parsed = Url::parse(base_url)
        .map_err(|e| AppError::InvalidProviderConfig(format!("invalid base_url: {e}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::InvalidProviderConfig(
            "base_url scheme must be http or https".into(),
        ));
    }

    if models.is_empty() {
        return Err(AppError::InvalidProviderConfig(
            "at least one model is required".into(),
        ));
    }

    let mut seen = std::collections::HashSet::new();
    for m in models {
        if m.id.trim().is_empty() {
            return Err(AppError::InvalidProviderConfig(
                "model id cannot be empty".into(),
            ));
        }
        if m.name.trim().is_empty() {
            return Err(AppError::InvalidProviderConfig(
                "model name cannot be empty".into(),
            ));
        }
        if !seen.insert(m.id.clone()) {
            return Err(AppError::InvalidProviderConfig(format!(
                "duplicate model id: {}",
                m.id
            )));
        }
    }

    if input_context_window == 0 || input_context_window > 200 {
        return Err(AppError::InvalidProviderConfig(
            "inputContextWindow must be in [1, 200]".into(),
        ));
    }
    if output_context_window == 0 || output_context_window > 128_000 {
        return Err(AppError::InvalidProviderConfig(
            "outputContextWindow must be in [1, 128000]".into(),
        ));
    }
    Ok(())
}

impl ConfigStore {
    pub async fn load() -> Result<Self> {
        let data_dir = app_data_dir()?;
        std::fs::create_dir_all(&data_dir).context("create data dir")?;
        migrate_legacy_config(&data_dir);
        let key_path = data_dir.join("venture.key");
        let config_path = data_dir.join("config.enc");
        let key = derive_or_create_key(&key_path)?;

        let mut state = if config_path.exists() {
            match std::fs::read(&config_path) {
                Ok(raw) => match decrypt(&key, &raw) {
                    Ok(plain) => match serde_json::from_slice::<ConfigFile>(&plain) {
                        Ok(cfg) => cfg,
                        Err(e) => {
                            // 解析失败：备份原文件，避免下次持久化直接覆盖丢配置
                            backup_corrupted_config(&config_path);
                            tracing::error!(
                                "config parse failed: {e}; original file has been backed up"
                            );
                            ConfigFile::default()
                        }
                    },
                    Err(e) => {
                        backup_corrupted_config(&config_path);
                        tracing::error!(
                            "config decrypt failed: {e}; original file has been backed up"
                        );
                        ConfigFile::default()
                    }
                },
                Err(e) => {
                    tracing::error!("read config failed: {e}");
                    ConfigFile::default()
                }
            }
        } else {
            ConfigFile::default()
        };

        let should_persist_merged_legacy = merge_legacy_provider_config(&mut state, &data_dir);
        let store = Self {
            key,
            config_path,
            state: Arc::new(RwLock::new(state)),
            persist_lock: tokio::sync::Mutex::new(()),
        };
        if should_persist_merged_legacy {
            store.persist().await?;
        }
        Ok(store)
    }

    async fn persist(&self) -> Result<(), AppError> {
        let _guard = self.persist_lock.lock().await;
        let plain = {
            let state = self.state.read().await;
            serde_json::to_vec(&*state)
                .map_err(|e| AppError::ConfigWriteFailed(e.to_string()))?
        };
        let encrypted = encrypt(&self.key, &plain)
            .map_err(|e| AppError::ConfigWriteFailed(e.to_string()))?;

        // tmp 文件唯一化（pid+timestamp+uuid），彻底避免多线程/多次调用竞争
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let unique = format!(
            "{}.{}.{}.tmp",
            std::process::id(),
            ts,
            &Uuid::new_v4().to_string()[..8]
        );
        let file_name = self
            .config_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("config.enc");
        let tmp_path = self
            .config_path
            .with_file_name(format!("{}.{}", file_name, unique));
        let config_path = self.config_path.clone();

        // 使用异步 I/O：tokio::fs 不会阻塞 runtime
        tokio::fs::write(&tmp_path, &encrypted)
            .await
            .map_err(|e| AppError::ConfigWriteFailed(e.to_string()))?;
        tokio::fs::rename(&tmp_path, &config_path)
            .await
            .map_err(|e| AppError::ConfigWriteFailed(e.to_string()))?;
        Ok(())
    }

    pub async fn list_providers(&self) -> Vec<ProviderPublic> {
        let state = self.state.read().await;
        state.providers.iter().map(ProviderPublic::from).collect()
    }

    pub async fn add_provider(
        &self,
        name: String,
        base_url: String,
        api_key: String,
        models: Vec<ModelEntry>,
        input_context_window: u32,
        output_context_window: u32,
    ) -> Result<ProviderPublic, AppError> {
        if name.trim().is_empty() {
            return Err(AppError::InvalidProviderConfig("name is required".into()));
        }
        validate_provider_input(&base_url, &models, input_context_window, output_context_window)?;
        let record = ProviderRecord {
            id: Uuid::new_v4().to_string(),
            name,
            base_url,
            api_key,
            models,
            input_context_window,
            output_context_window,
        };
        let public = ProviderPublic::from(&record);
        {
            let mut state = self.state.write().await;
            state.providers.push(record);
        }
        self.persist().await?;
        Ok(public)
    }

    pub async fn update_provider(
        &self,
        id: &str,
        name: Option<String>,
        base_url: Option<String>,
        api_key: Option<String>,
        models: Option<Vec<ModelEntry>>,
        input_context_window: Option<u32>,
        output_context_window: Option<u32>,
    ) -> Result<ProviderPublic, AppError> {
        let public = {
            let mut state = self.state.write().await;
            let record = state
                .providers
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or(AppError::ProviderNotFound)?;

            // 先构造预期的最终值再校验
            let next_base_url = base_url.clone().unwrap_or_else(|| record.base_url.clone());
            let next_models = models.clone().unwrap_or_else(|| record.models.clone());
            let next_input = input_context_window.unwrap_or(record.input_context_window);
            let next_output = output_context_window.unwrap_or(record.output_context_window);
            validate_provider_input(&next_base_url, &next_models, next_input, next_output)?;

            if let Some(n) = name {
                if n.trim().is_empty() {
                    return Err(AppError::InvalidProviderConfig("name is required".into()));
                }
                record.name = n;
            }
            if let Some(u) = base_url {
                record.base_url = u;
            }
            // 区分 None(不更新) 与 Some("")(清除密钥)
            if let Some(k) = api_key {
                record.api_key = k;
            }
            if let Some(m) = models {
                record.models = m;
            }
            if let Some(w) = input_context_window {
                record.input_context_window = w;
            }
            if let Some(w) = output_context_window {
                record.output_context_window = w;
            }
            ProviderPublic::from(&*record)
        };
        self.persist().await?;
        Ok(public)
    }

    pub async fn delete_provider(&self, id: &str) -> Result<(), AppError> {
        {
            let mut state = self.state.write().await;
            let len_before = state.providers.len();
            state.providers.retain(|p| p.id != id);
            if state.providers.len() == len_before {
                return Err(AppError::ProviderNotFound);
            }
        }
        self.persist().await
    }

    #[allow(dead_code)]
    pub async fn get_provider_record(&self, provider_id: &str) -> Option<ProviderRecord> {
        let state = self.state.read().await;
        state.providers.iter().find(|p| p.id == provider_id).cloned()
    }

    /// 复合键路由：优先按 (provider_id, model_id) 精确匹配，
    /// 无 provider_id 时回退到全局 model_id（兼容旧数据）
    pub async fn find_model(
        &self,
        provider_id: Option<&str>,
        model_id: &str,
    ) -> Option<(ProviderRecord, ModelEntry)> {
        let state = self.state.read().await;
        if let Some(pid) = provider_id {
            if let Some(provider) = state.providers.iter().find(|p| p.id == pid) {
                if let Some(model) = provider
                    .models
                    .iter()
                    .find(|m| m.id == model_id && m.enabled)
                {
                    return Some((provider.clone(), model.clone()));
                }
                return None;
            }
            return None;
        }
        for provider in &state.providers {
            for model in &provider.models {
                if model.id == model_id && model.enabled {
                    return Some((provider.clone(), model.clone()));
                }
            }
        }
        None
    }
}

fn backup_corrupted_config(path: &PathBuf) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("config.enc");
    let backup = path.with_file_name(format!("{}.corrupt.{}.bak", file_name, ts));
    if let Err(e) = std::fs::rename(path, &backup) {
        tracing::error!("failed to backup corrupted config: {e}");
    } else {
        tracing::warn!("corrupted config backed up to: {}", backup.display());
    }
}
