import { ComposerReference, ResourceComposerReference, UploadedResource, UploadedResourceKind } from '../types';
import { compressImageIfNeeded } from './imageCompressor';
import { debugLog, debugError } from './debugLogger';

export const MAX_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;

export const ACCEPTED_ATTACHMENT_TYPES = [
  'image/*',
  'text/*',
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.pdf',
  '.ppt',
  '.pptx',
  '.doc',
  '.docx',
].join(',');

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'log', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx']);

function getExtension(name: string) {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

export function getResourceKind(file: File): UploadedResourceKind {
  const mime = file.type.toLowerCase();
  const ext = getExtension(file.name);

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) return 'text';
  if (mime.includes('pdf') || ext === 'pdf') return 'pdf';
  if (mime.includes('presentation') || ext === 'ppt' || ext === 'pptx') return 'presentation';
  if (mime.includes('word') || ext === 'doc' || ext === 'docx') return 'document';
  return 'file';
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function readAsDataUrl(file: File, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const reader = new FileReader();
    const onAbort = () => {
      try { reader.abort(); } catch {}
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(String(reader.result ?? ''));
    };
    reader.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(reader.error ?? new Error('读取文件失败'));
    };
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const reader = new FileReader();
    const onAbort = () => {
      try { reader.abort(); } catch {}
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(String(reader.result ?? ''));
    };
    reader.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(reader.error ?? new Error('读取文本失败'));
    };
    reader.readAsText(file);
  });
}

export async function readFileAsUploadedResource(file: File, signal?: AbortSignal): Promise<UploadedResource> {
  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    throw new Error(`${file.name} 超过 ${formatFileSize(MAX_UPLOAD_SIZE_BYTES)} 限制`);
  }

  const kind = getResourceKind(file);
  let dataUrl = await readAsDataUrl(file, signal);
  
  debugLog('upload', 'file read done', {
    name: file.name,
    kind,
    originalSize: file.size,
    dataUrlLength: dataUrl.length,
  });

  if (kind === 'image') {
    try {
      const result = await compressImageIfNeeded(dataUrl);
      dataUrl = result.dataUrl;
      if (result.compressed) {
        debugLog('upload', 'image compressed', {
          name: file.name,
          compressionRatio: (result.compressionRatio * 100).toFixed(1) + '%',
        });
      }
    } catch (error) {
      debugError('upload', 'image compression failed', {
        name: file.name,
        error,
      });
      throw new Error(`${file.name} 压缩失败，请重试或上传较小的图片`);
    }
  }

  const textContent = kind === 'text' ? await readAsText(file, signal) : undefined;

  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    kind,
    dataUrl,
    textContent,
  };
}

export function createUploadedResourceReference(resource: UploadedResource): ResourceComposerReference {
  return {
    id: resource.id,
    kind: resource.kind === 'text' || resource.kind === 'document' || resource.kind === 'pdf' || resource.kind === 'presentation'
      ? 'doc'
      : 'file',
    label: resource.name,
    detail: formatFileSize(resource.size),
    description: resource.mimeType,
    resource,
  };
}

export function isUploadedResourceReference(reference: ComposerReference): reference is ResourceComposerReference & { resource: UploadedResource } {
  return reference.kind !== 'code' && Boolean(reference.resource);
}

export function isImageResource(reference: ComposerReference) {
  return isUploadedResourceReference(reference) && reference.resource.kind === 'image';
}

export function getResourceSummary(reference: ComposerReference) {
  if (!isUploadedResourceReference(reference)) return reference.detail ?? reference.description ?? '';
  const { resource } = reference;
  return `${formatFileSize(resource.size)}${resource.mimeType ? ` · ${resource.mimeType}` : ''}`;
}
