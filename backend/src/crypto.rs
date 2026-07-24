use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use aes_gcm::aead::rand_core::RngCore;
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::path::PathBuf;

/// 派生或创建 AES-256 密钥文件
///
/// 说明：
/// - 密钥文件位于每个用户的 %LOCALAPPDATA%\venture\Venture 目录，NTFS 已默认限制为该用户
/// - 我们额外将文件设置为 `Hidden` 属性以降低误操作/误提交风险
/// - 若要更强保护（DPAPI/Credential Manager），请参考 UNIFIED_REVIEW_REPORT P0-009
pub fn derive_or_create_key(key_path: &PathBuf) -> Result<[u8; 32]> {
    if key_path.exists() {
        let data = std::fs::read(key_path).context("read key file")?;
        // 兼容含有换行/空白的历史文件
        let trimmed: Vec<u8> = data
            .into_iter()
            .filter(|b| !b.is_ascii_whitespace())
            .collect();
        let decoded = BASE64
            .decode(&trimmed)
            .context("decode key")?;
        if decoded.len() != 32 {
            anyhow::bail!("invalid key length: expected 32 bytes, got {}", decoded.len());
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&decoded);
        Ok(key)
    } else {
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        let encoded = BASE64.encode(key);
        if let Some(parent) = key_path.parent() {
            std::fs::create_dir_all(parent).context("create key dir")?;
        }
        std::fs::write(key_path, encoded.as_bytes()).context("write key file")?;
        set_hidden_if_windows(key_path);
        Ok(key)
    }
}

#[cfg(windows)]
fn set_hidden_if_windows(path: &PathBuf) {
    use std::os::windows::ffi::OsStrExt;
    // 直接调用 Win32 SetFileAttributesW，标记 HIDDEN | NOT_CONTENT_INDEXED
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_NOT_CONTENT_INDEXED: u32 = 0x2000;
    extern "system" {
        fn SetFileAttributesW(lp_file_name: *const u16, dw_file_attributes: u32) -> i32;
    }
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        SetFileAttributesW(
            wide.as_ptr(),
            FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED,
        );
    }
}

#[cfg(not(windows))]
fn set_hidden_if_windows(_path: &PathBuf) {}

pub fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher_key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(cipher_key);
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow::anyhow!("encrypt failed: {e}"))?;
    let mut result = Vec::with_capacity(12 + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

pub fn decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>> {
    if data.len() < 12 {
        anyhow::bail!("ciphertext too short");
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher_key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(cipher_key);
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow::anyhow!("decrypt failed: {e}"))
}
