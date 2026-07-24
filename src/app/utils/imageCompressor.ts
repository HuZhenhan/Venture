import { debugLog, debugError } from './debugLogger';

export interface ImageCompressionOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  maxSizeBytes?: number;
}

const DEFAULT_MAX_WIDTH = 1920;
const DEFAULT_MAX_HEIGHT = 1080;
const DEFAULT_QUALITY = 0.8;
const DEFAULT_MAX_SIZE = 2 * 1024 * 1024;

async function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => reject(new Error('图片尺寸获取失败'));
    img.src = dataUrl;
  });
}

function calculateScaleFactor(width: number, height: number, maxWidth: number, maxHeight: number): number {
  const widthRatio = width > maxWidth ? maxWidth / width : 1;
  const heightRatio = height > maxHeight ? maxHeight / height : 1;
  return Math.min(widthRatio, heightRatio);
}

async function compressImageCanvas(
  dataUrl: string,
  options: ImageCompressionOptions = {},
): Promise<{ dataUrl: string; originalSize: number; compressedSize: number; quality: number }> {
  const startTime = performance.now();
  const originalSize = dataUrl.length;
  
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
  const targetQuality = options.quality ?? DEFAULT_QUALITY;

  try {
    const dimensions = await getImageDimensions(dataUrl);
    const scale = calculateScaleFactor(dimensions.width, dimensions.height, maxWidth, maxHeight);

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(dimensions.width * scale);
    canvas.height = Math.round(dimensions.height * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 canvas context');

    const img = new Image();
    img.src = dataUrl;

    return new Promise((resolve, reject) => {
      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          let quality = targetQuality;
          let compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
          let compressedSize = compressedDataUrl.length;

          while (compressedSize > (options.maxSizeBytes ?? DEFAULT_MAX_SIZE) && quality > 0.1) {
            quality -= 0.1;
            compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
            compressedSize = compressedDataUrl.length;
          }

          const elapsedMs = Math.round(performance.now() - startTime);
          debugLog('compress', 'success', {
            originalSize,
            compressedSize,
            ratio: (compressedSize / originalSize * 100).toFixed(1) + '%',
            quality: (quality * 100).toFixed(0) + '%',
            dimensions: `${dimensions.width}x${dimensions.height}`,
            scaled: `${canvas.width}x${canvas.height}`,
            elapsedMs,
          });

          resolve({
            dataUrl: compressedDataUrl,
            originalSize,
            compressedSize,
            quality,
          });
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => reject(new Error('图片加载失败'));
    });
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startTime);
    debugError('compress', 'failed', {
      originalSize,
      elapsedMs,
      error,
    });
    throw error;
  }
}

export async function compressImageIfNeeded(
  dataUrl: string,
  options: ImageCompressionOptions = {},
): Promise<{ dataUrl: string; compressed: boolean; compressionRatio: number }> {
  const threshold = options.maxSizeBytes ?? DEFAULT_MAX_SIZE;

  if (dataUrl.length <= threshold) {
    debugLog('compress', 'skip (under threshold)', {
      size: dataUrl.length,
      threshold,
    });
    return {
      dataUrl,
      compressed: false,
      compressionRatio: 1,
    };
  }

  const result = await compressImageCanvas(dataUrl, options);
  return {
    dataUrl: result.dataUrl,
    compressed: true,
    compressionRatio: result.compressedSize / result.originalSize,
  };
}
