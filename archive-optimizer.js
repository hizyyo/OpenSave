(function initializeArchiveOptimizer(globalScope) {
  'use strict';

  const DEFAULT_LARGE_MEDIA_BYTES = 25 * 1024 * 1024;
  const DEFAULT_WARNING_BYTES = 500 * 1024 * 1024;
  const SOURCE_MAP_PATTERN = /(?:\.map(?:$|[?#])|(?:application|text)\/json[^;]*;?[^\n]*source-?map)/i;
  const ALREADY_COMPRESSED_PATTERN = /(?:^|\/)(?:audio|video|image)\/|font\/(?:woff2?|otf)|application\/(?:wasm|zip|gzip|pdf)|\.(?:avif|br|gif|gz|jpe?g|mp3|mp4|ogg|png|webm|webp|woff2?|zip)(?:$|[?#])/i;

  function bodySize(body, base64Encoded = false) {
    if (body == null) return 0;
    if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
    if (body instanceof Uint8Array) return body.byteLength;
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return body.byteLength;
    const value = String(body);
    if (base64Encoded) {
      const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
      return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
    }
    return new TextEncoder().encode(value).byteLength;
  }

  function normalizedMimeType(value) {
    return String(value || '').split(';', 1)[0].trim().toLowerCase();
  }

  function isTextResource(resource) {
    const type = normalizedMimeType(resource && resource.mimeType);
    return type.startsWith('text/') || /(?:java|ecma)script|json|xml|svg|gltf/.test(type);
  }

  function isSourceMap(resource) {
    const url = String(resource && resource.url || '');
    const type = String(resource && resource.mimeType || '');
    return /\.map(?:$|[?#])/i.test(url) || SOURCE_MAP_PATTERN.test(type);
  }

  function isLargeMedia(resource, thresholdBytes = DEFAULT_LARGE_MEDIA_BYTES) {
    const type = normalizedMimeType(resource && resource.mimeType);
    return /^(?:audio|video)\//.test(type) && bodySize(resource.body, resource.base64Encoded) >= thresholdBytes;
  }

  function textBaseScope(urlValue) {
    try {
      const url = new URL(urlValue);
      const slash = url.pathname.lastIndexOf('/');
      return `${url.origin}${url.pathname.slice(0, slash + 1)}`;
    } catch (error) {
      return String(urlValue || '');
    }
  }

  function deduplicationKey(resource, normalizedUrl) {
    if (!resource || resource.routePage || !resource.contentHash) return '';
    const type = normalizedMimeType(resource.mimeType);
    const scope = isTextResource(resource) ? textBaseScope(normalizedUrl) : 'binary';
    return `${resource.contentHash}\n${type}\n${scope}`;
  }

  async function deflatedSize(file, size, typeHint) {
    if (typeof CompressionStream !== 'undefined') {
      try {
        const source = file.bytes instanceof Uint8Array
          ? file.bytes
          : typeof Blob !== 'undefined' && file.body instanceof Blob
            ? new Uint8Array(await file.body.arrayBuffer())
            : new TextEncoder().encode(String(file.body ?? ''));
        const compressed = await new Response(new Blob([source]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
        return compressed.byteLength;
      } catch (error) {
        // Fall back to a deterministic MIME-weighted estimate.
      }
    }
    const ratio = ALREADY_COMPRESSED_PATTERN.test(typeHint) ? 0.99 : isTextResource(file) || /\.(?:css|html?|js|json|map|svg|txt|xml)$/i.test(file.path || file.name || '') ? 0.52 : 0.82;
    return Math.ceil(size * ratio);
  }

  async function estimateArchive(files) {
    let physicalBytes = 0;
    let estimatedCompressedBytes = 0;
    let entryOverheadBytes = 22;
    for (const file of files || []) {
      const size = Number.isFinite(file.size) ? file.size : bodySize(file.bytes ?? file.body, file.base64Encoded);
      const path = String(file.path || file.name || 'file');
      const typeHint = `${file.mimeType || ''}/${path}`;
      physicalBytes += size;
      estimatedCompressedBytes += await deflatedSize(file, size, typeHint);
      entryOverheadBytes += 92 + new TextEncoder().encode(path).byteLength * 2;
    }
    return {
      fileCount: (files || []).length,
      physicalBytes,
      estimatedArchiveBytes: estimatedCompressedBytes + entryOverheadBytes,
      estimatedCompressionBytesSaved: Math.max(0, physicalBytes - estimatedCompressedBytes),
      method: 'mime-weighted-deflate-v1'
    };
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  const api = {
    DEFAULT_LARGE_MEDIA_BYTES,
    DEFAULT_WARNING_BYTES,
    bodySize,
    normalizedMimeType,
    isTextResource,
    isSourceMap,
    isLargeMedia,
    deduplicationKey,
    estimateArchive,
    formatBytes
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.OpenSaveArchiveOptimizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
