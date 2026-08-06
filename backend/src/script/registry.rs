//! 脚本注册表（DSL 规格书 §1 Script Registry + §12.5 分级）。
//!
//! 存储：app_data/scripts/*.json（用户/分享脚本）；内置脚本编译进二进制（只读）。
//! 名称唯一：用户脚本不可与内置脚本重名（复制为模板时需改名）。

use super::builtins;
use super::model::{ScriptDef, ScriptSource, ScriptSummary};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::sync::RwLock;

pub struct ScriptRegistry {
    dir: PathBuf,
    user_scripts: RwLock<HashMap<String, ScriptDef>>,
}

impl ScriptRegistry {
    pub async fn load(dir: PathBuf) -> anyhow::Result<Self> {
        tokio::fs::create_dir_all(&dir).await?;
        let mut map = HashMap::new();
        let mut entries = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match tokio::fs::read_to_string(&path).await {
                Ok(content) => match serde_json::from_str::<ScriptDef>(&content) {
                    Ok(script) => {
                        map.insert(script.name.clone(), script);
                    }
                    Err(e) => {
                        tracing::warn!("脚本文件解析失败 {:?}: {e}", path);
                    }
                },
                Err(e) => tracing::warn!("脚本文件读取失败 {:?}: {e}", path),
            }
        }
        Ok(Self { dir, user_scripts: RwLock::new(map) })
    }

    fn builtin_map() -> HashMap<String, ScriptDef> {
        builtins::builtin_scripts()
            .into_iter()
            .map(|s| (s.name.clone(), s))
            .collect()
    }

    pub async fn get(&self, name: &str) -> Option<ScriptDef> {
        if let Some(s) = self.user_scripts.read().await.get(name) {
            return Some(s.clone());
        }
        Self::builtin_map().get(name).cloned()
    }

    pub async fn list(&self) -> Vec<ScriptSummary> {
        let mut all: Vec<ScriptDef> = Self::builtin_map().into_values().collect();
        all.extend(self.user_scripts.read().await.values().cloned());
        all.sort_by(|a, b| a.name.cmp(&b.name));
        all.iter().map(ScriptSummary::from).collect()
    }

    /// 注册/更新用户脚本（内置脚本不可覆盖）
    pub async fn upsert(&self, mut script: ScriptDef) -> Result<(), String> {
        if Self::builtin_map().contains_key(&script.name)
            && script.source == ScriptSource::Builtin
        {
            return Err(format!("内置脚本 {} 只读，不可覆盖（可复制为模板后改名）", script.name));
        }
        if Self::builtin_map().contains_key(&script.name) {
            return Err(format!("脚本名 {} 与内置脚本冲突，请改名", script.name));
        }
        if script.source == ScriptSource::Builtin {
            script.source = ScriptSource::User;
        }
        self.persist(&script).await.map_err(|e| format!("脚本保存失败: {e}"))?;
        self.user_scripts.write().await.insert(script.name.clone(), script);
        Ok(())
    }

    pub async fn delete(&self, name: &str) -> Result<(), String> {
        if Self::builtin_map().contains_key(name) {
            return Err(format!("内置脚本 {name} 只读，不可删除"));
        }
        let removed = self.user_scripts.write().await.remove(name);
        if removed.is_none() {
            return Err(format!("脚本 {name} 不存在"));
        }
        let path = self.dir.join(format!("{name}.json"));
        if path.exists() {
            tokio::fs::remove_file(&path).await.map_err(|e| format!("脚本文件删除失败: {e}"))?;
        }
        Ok(())
    }

    pub async fn set_enabled(&self, name: &str, enabled: bool) -> Result<(), String> {
        let mut guard = self.user_scripts.write().await;
        if let Some(script) = guard.get_mut(name) {
            script.enabled = enabled;
            let snapshot = script.clone();
            drop(guard);
            self.persist(&snapshot).await.map_err(|e| format!("脚本保存失败: {e}"))?;
            return Ok(());
        }
        drop(guard);
        Err(format!("脚本 {name} 不存在或为内置脚本（内置脚本不可禁用）"))
    }

    pub async fn increment_run_count(&self, name: &str) {
        let mut guard = self.user_scripts.write().await;
        if let Some(script) = guard.get_mut(name) {
            script.run_count += 1;
            let snapshot = script.clone();
            drop(guard);
            let _ = self.persist(&snapshot).await;
        }
    }

    async fn persist(&self, script: &ScriptDef) -> anyhow::Result<()> {
        let path = self.dir.join(format!("{}.json", script.name));
        let content = serde_json::to_string_pretty(script)?;
        tokio::fs::write(path, content).await?;
        Ok(())
    }
}
