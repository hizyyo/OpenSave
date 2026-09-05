(function initializeResourceParser(globalScope) {
  'use strict';

  const EXECUTABLE_ROLES = new Set(['script', 'module', 'stylesheet', 'css-import']);
  const URL_ATTRIBUTES = new Set(['src', 'href', 'data', 'poster', 'action', 'formaction', 'cite', 'background']);
  const LAZY_URL_ATTRIBUTES = new Set(['data-src', 'data-lazy-src', 'data-original', 'data-bg', 'data-background']);
  const SRCSET_ATTRIBUTES = new Set(['srcset', 'data-srcset', 'data-lazy-srcset']);
  const SVG_URL_ATTRIBUTES = new Set(['href', 'xlink:href']);
  const SVG_PAINT_ATTRIBUTES = new Set(['filter', 'mask', 'clip-path', 'fill', 'stroke', 'cursor', 'marker', 'marker-start', 'marker-mid', 'marker-end']);
  const SVG_ELEMENTS = new Set(['svg', 'use', 'image', 'script', 'a', 'feimage', 'mpath', 'animate', 'set', 'lineargradient', 'radialgradient', 'pattern', 'filter', 'mask', 'clippath', 'marker']);

  function normalizeUrl(value, baseUrl) {
    if (!value) return '';
    const url = new URL(value, baseUrl);
    url.hash = '';
    return url.href;
  }

  function resolveRawUrl(value, baseUrl) {
    if (!value || /^\s*$/.test(value)) return null;
    if (/^#/.test(value)) return { kind: 'fragment', href: value, normalizedUrl: '' };
    const url = new URL(value, baseUrl);
    if (['data:', 'blob:'].includes(url.protocol)) return { kind: 'embedded', href: url.href, normalizedUrl: url.href };
    if (!['http:', 'https:'].includes(url.protocol)) return { kind: 'non-fetch', href: value, normalizedUrl: '' };
    const hash = url.hash;
    url.hash = '';
    return { kind: 'network', href: `${url.href}${hash}`, normalizedUrl: url.href, hash };
  }

  function createReference(input) {
    const location = input.location || (input.range ? { byteRange: input.range } : null);
    return {
      ownerArtifact: input.ownerArtifact || null,
      baseUrl: input.baseUrl || null,
      syntaxKind: input.syntaxKind || 'unknown',
      rawValue: input.rawValue || '',
      resolvedUrl: input.resolvedUrl || null,
      location,
      role: input.role || 'resource',
      rewritePolicy: input.rewritePolicy || policyForRole(input.role),
      range: input.range || (location && location.byteRange) || null,
      quote: input.quote || '',
      disposition: input.disposition || 'discovered',
      reasonCode: input.reasonCode || null
    };
  }

  function policyForRole(role) {
    if (EXECUTABLE_ROLES.has(role)) return 'block-unresolved-executable';
    if (role === 'navigation') return 'preserve-navigation';
    return 'block-unresolved-subresource';
  }

  function resourceEntries(resources) {
    if (!resources) return [];
    if (resources instanceof Map) return [...resources.entries()];
    return Object.entries(resources);
  }

  function createResolver(options = {}) {
    const resources = new Map();
    const aliases = new Map();
    const redirects = new Map();

    for (const [url, value] of resourceEntries(options.resources)) {
      try { resources.set(normalizeUrl(url), typeof value === 'string' ? value : value.localPath || value.replayUrl || ''); } catch (error) {}
    }
    for (const [url, target] of resourceEntries(options.aliases)) {
      try { aliases.set(normalizeUrl(url), normalizeUrl(target)); } catch (error) {}
    }
    for (const [url, target] of resourceEntries(options.redirects)) {
      try { redirects.set(normalizeUrl(url), normalizeUrl(target)); } catch (error) {}
    }

    const lookup = (url) => {
      const visited = new Set();
      let current = url;
      while (current && !visited.has(current)) {
        visited.add(current);
        if (resources.has(current)) return resources.get(current);
        current = aliases.get(current) || redirects.get(current);
      }
      return null;
    };

    return {
      resolve(reference, baseUrl) {
        let resolved;
        try {
          resolved = resolveRawUrl(reference.rawValue, reference.baseUrl || baseUrl);
        } catch (error) {
          return { ...reference, disposition: 'unresolved', reasonCode: 'invalid-url', replacement: reference.rawValue };
        }
        if (!resolved) return { ...reference, disposition: 'unresolved', reasonCode: 'empty-url', replacement: reference.rawValue };
        if (resolved.kind === 'fragment' || resolved.kind === 'embedded' || resolved.kind === 'non-fetch') {
          return { ...reference, resolvedUrl: resolved.href, disposition: 'preserved', reasonCode: resolved.kind, replacement: reference.rawValue };
        }
        const localPath = lookup(resolved.normalizedUrl);
        if (localPath) {
          const replayUrl = `${localPath.startsWith('/') ? '' : '/'}${localPath}${resolved.hash || ''}`;
          return { ...reference, resolvedUrl: resolved.href, disposition: 'localized', reasonCode: 'captured', replacement: replayUrl };
        }
        if (reference.rewritePolicy === 'preserve-navigation') {
          return { ...reference, resolvedUrl: resolved.href, disposition: 'preserved', reasonCode: 'navigation', replacement: reference.rawValue };
        }
        if (reference.rewritePolicy === 'localize-if-captured') {
          return { ...reference, resolvedUrl: resolved.href, disposition: 'preserved', reasonCode: 'uncaptured-runtime-resource', replacement: reference.rawValue };
        }
        const executable = reference.rewritePolicy === 'block-unresolved-executable';
        return {
          ...reference,
          resolvedUrl: resolved.href,
          disposition: 'blocked',
          reasonCode: executable ? 'unresolved-executable' : 'unresolved-subresource',
          replacement: blockedValue(reference.role)
        };
      }
    };
  }

  function blockedValue(role) {
    if (role === 'stylesheet' || role === 'css-import') return 'data:text/css,';
    if (role === 'script' || role === 'module') return 'data:text/javascript,export%20{}';
    if (role === 'frame') return 'about:blank';
    return 'data:,';
  }

  function decodeCssEscapes(value) {
    return value.replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\\([^\r\n\f])/gi, (whole, hex, escaped) => {
      if (hex) return String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff));
      return escaped || '';
    });
  }

  function scanCssString(source, start) {
    const quote = source[start];
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') { index += source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2; continue; }
      if (source[index] === quote) return { start: start + 1, end: index, quote, next: index + 1 };
      index += 1;
    }
    throw new SyntaxError('Unterminated CSS string');
  }

  function cssContextRole(source, index, fontFaceDepth) {
    if (fontFaceDepth > 0) return 'font';
    const statementStart = Math.max(source.lastIndexOf(';', index), source.lastIndexOf('{', index));
    return /@import\s*(?:url\s*\()?\s*$/i.test(source.slice(statementStart + 1, index)) ? 'css-import' : 'image';
  }

  function discoverCssReferences(source, options = {}) {
    const references = [];
    const ownerArtifact = options.ownerArtifact || null;
    let index = 0;
    let depth = 0;
    const fontFaceDepths = [];
    let pendingFontFace = false;

    const add = (start, end, syntaxKind, role, quote = '') => {
      const rawValue = decodeCssEscapes(source.slice(start, end).trim());
      const leftTrim = source.slice(start, end).search(/\S|$/);
      const rightTrim = source.slice(start, end).length - source.slice(start, end).trimEnd().length;
      const range = { start: start + leftTrim, end: end - rightTrim };
      let resolvedUrl = null;
      try { resolvedUrl = resolveRawUrl(rawValue, options.baseUrl) ?.href || null; } catch (error) {}
      references.push(createReference({ ownerArtifact, baseUrl: options.baseUrl, syntaxKind, rawValue, resolvedUrl, range, role, quote }));
    };

    while (index < source.length) {
      if (source.startsWith('/*', index)) {
        const end = source.indexOf('*/', index + 2);
        if (end < 0) throw new SyntaxError('Unterminated CSS comment');
        index = end + 2;
        continue;
      }
      if (source[index] === '"' || source[index] === "'") { index = scanCssString(source, index).next; continue; }
      if (/^@font-face\b/i.test(source.slice(index))) { pendingFontFace = true; index += 10; continue; }
      if (source[index] === '{') {
        depth += 1;
        if (pendingFontFace) { fontFaceDepths.push(depth); pendingFontFace = false; }
        index += 1;
        continue;
      }
      if (source[index] === '}') {
        if (fontFaceDepths[fontFaceDepths.length - 1] === depth) fontFaceDepths.pop();
        depth = Math.max(0, depth - 1);
        index += 1;
        continue;
      }
      const urlMatch = source.slice(index).match(/^url\s*\(/i);
      if (urlMatch) {
        let cursor = index + urlMatch[0].length;
        while (/\s/.test(source[cursor] || '')) cursor += 1;
        const role = cssContextRole(source, index, fontFaceDepths.length);
        if (source[cursor] === '"' || source[cursor] === "'") {
          const string = scanCssString(source, cursor);
          add(string.start, string.end, role === 'css-import' ? 'css-import' : 'css-url', role, string.quote);
          cursor = string.next;
        } else {
          const start = cursor;
          let nested = 0;
          while (cursor < source.length) {
            if (source[cursor] === '\\') { cursor += 2; continue; }
            if (source[cursor] === '(') nested += 1;
            if (source[cursor] === ')' && nested === 0) break;
            if (source[cursor] === ')') nested -= 1;
            cursor += 1;
          }
          if (cursor >= source.length) throw new SyntaxError('Unterminated CSS url()');
          add(start, cursor, role === 'css-import' ? 'css-import' : 'css-url', role);
        }
        index = cursor + 1;
        continue;
      }
      const importMatch = source.slice(index).match(/^@import\s+/i);
      if (importMatch) {
        let cursor = index + importMatch[0].length;
        while (/\s/.test(source[cursor] || '')) cursor += 1;
        if (source[cursor] === '"' || source[cursor] === "'") {
          const string = scanCssString(source, cursor);
          add(string.start, string.end, 'css-import', 'css-import', string.quote);
          index = string.next;
          continue;
        }
      }
      const imageSetMatch = source.slice(index).match(/^(?:-webkit-)?image-set\s*\(/i);
      if (imageSetMatch) {
        let cursor = index + imageSetMatch[0].length;
        let imageDepth = 1;
        while (cursor < source.length && imageDepth > 0) {
          const nestedUrlMatch = source.slice(cursor).match(/^url\s*\(/i);
          if (nestedUrlMatch) {
            cursor += nestedUrlMatch[0].length;
            while (/\s/.test(source[cursor] || '')) cursor += 1;
            if (source[cursor] === '"' || source[cursor] === "'") {
              const string = scanCssString(source, cursor);
              add(string.start, string.end, 'css-image-set', 'image', string.quote);
              cursor = string.next;
            } else {
              const start = cursor;
              let nested = 0;
              while (cursor < source.length) {
                if (source[cursor] === '\\') { cursor += 2; continue; }
                if (source[cursor] === '(') nested += 1;
                if (source[cursor] === ')' && nested === 0) break;
                if (source[cursor] === ')') nested -= 1;
                cursor += 1;
              }
              if (cursor >= source.length) throw new SyntaxError('Unterminated CSS image-set url()');
              add(start, cursor, 'css-image-set', 'image');
            }
            while (/\s/.test(source[cursor] || '')) cursor += 1;
            if (source[cursor] !== ')') throw new SyntaxError('Unterminated CSS image-set url()');
            cursor += 1;
            continue;
          }
          if (source[cursor] === '"' || source[cursor] === "'") {
            const string = scanCssString(source, cursor);
            add(string.start, string.end, 'css-image-set', 'image', string.quote);
            cursor = string.next;
            continue;
          }
          if (source[cursor] === '(') imageDepth += 1;
          if (source[cursor] === ')') imageDepth -= 1;
          cursor += 1;
        }
        if (imageDepth) throw new SyntaxError('Unterminated CSS image-set()');
        index = cursor;
        continue;
      }
      index += 1;
    }
    return references;
  }

  function decodeJavaScriptString(value) {
    return value.replace(/\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([0btnvfr'"\\]))/gi, (whole, point, unicode, hex, simple) => {
      if (point) return String.fromCodePoint(Number.parseInt(point, 16));
      if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      return ({ 0: '\0', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' })[simple] || simple;
    }).replace(/\\(?:\r\n|[\n\r])/g, '');
  }

  function decodeHtmlEntities(value) {
    return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|quot|apos|lt|gt);/gi, (entity, decimal, hex) => {
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' })[entity.toLowerCase()] || entity;
    });
  }

  function scanJavaScriptString(source, start) {
    const quote = source[start];
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') { index += source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2; continue; }
      if (source[index] === quote) return { type: 'string', value: decodeJavaScriptString(source.slice(start + 1, index)), start: start + 1, end: index, quote, next: index + 1 };
      if (source[index] === '\n' || source[index] === '\r') throw new SyntaxError('Unterminated JavaScript string');
      index += 1;
    }
    throw new SyntaxError('Unterminated JavaScript string');
  }

  function skipTemplate(source, start) {
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index] === '`') return index + 1;
      index += 1;
    }
    throw new SyntaxError('Unterminated JavaScript template');
  }

  function skipRegex(source, start) {
    let index = start + 1;
    let characterClass = false;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index] === '[') characterClass = true;
      if (source[index] === ']') characterClass = false;
      if (source[index] === '/' && !characterClass) {
        index += 1;
        while (/[a-z]/i.test(source[index] || '')) index += 1;
        return index;
      }
      if (source[index] === '\n' || source[index] === '\r') return start + 1;
      index += 1;
    }
    return start + 1;
  }

  function tokenizeJavaScript(source) {
    const tokens = [];
    let index = 0;
    let canStartRegex = true;
    while (index < source.length) {
      const character = source[index];
      if (/\s/.test(character)) { index += 1; continue; }
      if (source.startsWith('//', index)) { const end = source.indexOf('\n', index + 2); index = end < 0 ? source.length : end + 1; continue; }
      if (source.startsWith('/*', index)) { const end = source.indexOf('*/', index + 2); if (end < 0) throw new SyntaxError('Unterminated JavaScript comment'); index = end + 2; continue; }
      if (character === '"' || character === "'") { const token = scanJavaScriptString(source, index); tokens.push(token); index = token.next; canStartRegex = false; continue; }
      if (character === '`') { index = skipTemplate(source, index); tokens.push({ type: 'template' }); canStartRegex = false; continue; }
      if (character === '/' && canStartRegex) { index = skipRegex(source, index); tokens.push({ type: 'regex' }); canStartRegex = false; continue; }
      const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/);
      if (identifier) {
        tokens.push({ type: 'identifier', value: identifier[0], start: index, end: index + identifier[0].length });
        canStartRegex = /^(?:return|throw|case|delete|void|typeof|instanceof|in|of|new|yield|await|else|do)$/.test(identifier[0]);
        index += identifier[0].length;
        continue;
      }
      tokens.push({ type: 'punctuator', value: character, start: index, end: index + 1 });
      canStartRegex = /[({[,:;=!?&|+\-*%^~<>]/.test(character);
      index += 1;
    }
    return tokens;
  }

  function discoverJavaScriptReferences(source, options = {}) {
    const tokens = tokenizeJavaScript(source);
    const references = [];
    const add = (token, syntaxKind, role = 'module', rewritePolicy) => {
      if (!/^(?:\.\.?\/|\/|https?:|data:|blob:)/i.test(token.value)) return;
      let resolvedUrl = null;
      try { resolvedUrl = resolveRawUrl(token.value, options.baseUrl) ?.href || null; } catch (error) {}
      references.push(createReference({
        ownerArtifact: options.ownerArtifact,
        baseUrl: options.baseUrl,
        syntaxKind,
        rawValue: token.value,
        resolvedUrl,
        range: { start: token.start, end: token.end },
        role,
        quote: token.quote,
        rewritePolicy
      }));
    };
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.type === 'identifier' && token.value === 'src'
        && tokens[index - 1] && tokens[index - 1].value === '.'
        && tokens[index + 1] && tokens[index + 1].value === '='
        && tokens[index + 2] && tokens[index + 2].type === 'string'
        && (!tokens[index + 3] || [';', ')', ']', '}'].includes(tokens[index + 3].value))) {
        add(tokens[index + 2], 'javascript-src-assignment', 'script');
        continue;
      }
      if (token.type === 'identifier' && token.value === 'setAttribute'
        && tokens[index + 1] && tokens[index + 1].value === '('
        && tokens[index + 2] && tokens[index + 2].type === 'string' && tokens[index + 2].value.toLowerCase() === 'src'
        && tokens[index + 3] && tokens[index + 3].value === ','
        && tokens[index + 4] && tokens[index + 4].type === 'string'
        && tokens[index + 5] && tokens[index + 5].value === ')') {
        add(tokens[index + 4], 'javascript-setattribute-src', 'script');
        continue;
      }
      if (token.type !== 'identifier' || !['import', 'export'].includes(token.value)) continue;
      const next = tokens[index + 1];
      if (token.value === 'import' && next && next.value === '.') continue;
      if (token.value === 'import' && next && next.value === '(') {
        if (tokens[index + 2] && tokens[index + 2].type === 'string' && tokens[index + 3] && [')', ','].includes(tokens[index + 3].value)) add(tokens[index + 2], 'javascript-dynamic-import');
        continue;
      }
      if (token.value === 'import' && next && next.type === 'string') { add(next, 'javascript-import'); continue; }
      for (let cursor = index + 1; cursor < tokens.length && cursor < index + 40; cursor += 1) {
        if (tokens[cursor].value === ';') break;
        if (tokens[cursor].type === 'identifier' && tokens[cursor].value === 'from' && tokens[cursor + 1] && tokens[cursor + 1].type === 'string') {
          add(tokens[cursor + 1], token.value === 'export' ? 'javascript-export-from' : 'javascript-import-from');
          break;
        }
      }
    }
    for (const token of tokens) {
      if (token.type !== 'string' || !/^https?:/i.test(token.value)) continue;
      if (!/\.(?:avif|gif|ico|jpe?g|json|mp4|otf|png|svg|ttf|webm|webp|woff2?)(?:[?#]|$)/i.test(token.value)) continue;
      if (references.some((reference) => reference.range && reference.range.start === token.start && reference.range.end === token.end)) continue;
      const extension = token.value.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1].toLowerCase();
      const role = /^(?:avif|gif|ico|jpe?g|png|svg|webp)$/.test(extension || '') ? 'image'
        : /^(?:mp4|webm)$/.test(extension || '') ? 'media'
          : /^(?:otf|ttf|woff2?)$/.test(extension || '') ? 'font'
            : 'resource';
      add(token, 'javascript-static-asset-url', role, 'localize-if-captured');
    }
    return references;
  }

  function discoverSrcsetReferences(source, options = {}) {
    const references = [];
    let index = 0;
    while (index < source.length) {
      while (/[\s,]/.test(source[index] || '')) index += 1;
      if (index >= source.length) break;
      const start = index;
      const dataUrl = /^data:/i.test(source.slice(index));
      while (index < source.length && !/\s/.test(source[index]) && (dataUrl || source[index] !== ',')) index += 1;
      const end = index;
      while (index < source.length && source[index] !== ',') index += 1;
      if (source[index] === ',') index += 1;
      const rawValue = source.slice(start, end);
      let resolvedUrl = null;
      try { resolvedUrl = resolveRawUrl(rawValue, options.baseUrl) ?.href || null; } catch (error) {}
      references.push(createReference({ ownerArtifact: options.ownerArtifact, baseUrl: options.baseUrl, syntaxKind: 'html-srcset-candidate', rawValue, resolvedUrl, range: { start, end }, role: 'image' }));
    }
    return references;
  }

  function htmlRole(tagName, attribute, attributes) {
    if (attribute === 'action' || attribute === 'formaction' || tagName === 'a' || tagName === 'area') return 'navigation';
    if (tagName === 'script') return 'script';
    if (tagName === 'iframe' || tagName === 'frame') return 'frame';
    if (tagName === 'link') {
      const rel = (attributes.get('rel') ?.value || '').toLowerCase();
      if (/\bstylesheet\b/.test(rel)) return 'stylesheet';
      if (/\bmodulepreload\b/.test(rel)) return 'module';
      if (/\b(?:icon|preload|manifest)\b/.test(rel)) return 'resource';
      return 'navigation';
    }
    if (['img', 'image', 'source', 'input'].includes(tagName) || attribute.includes('background')) return 'image';
    if (['video', 'audio', 'track'].includes(tagName) || attribute === 'poster') return 'media';
    if (['object', 'embed'].includes(tagName)) return 'object';
    return 'resource';
  }

  function parseHtmlStartTag(source, start) {
    let index = start + 1;
    const nameMatch = source.slice(index).match(/^[A-Za-z][\w:-]*/);
    if (!nameMatch) return null;
    const tagName = nameMatch[0].toLowerCase();
    index += nameMatch[0].length;
    const attributes = new Map();
    while (index < source.length) {
      while (/\s/.test(source[index] || '')) index += 1;
      if (source[index] === '>' || source.startsWith('/>', index)) return { tagName, attributes, end: source[index] === '>' ? index + 1 : index + 2 };
      const attributeMatch = source.slice(index).match(/^[^\s=/>]+/);
      if (!attributeMatch) { index += 1; continue; }
      const name = attributeMatch[0].toLowerCase();
      index += attributeMatch[0].length;
      while (/\s/.test(source[index] || '')) index += 1;
      let value = '';
      let valueStart = index;
      let valueEnd = index;
      let quote = '';
      if (source[index] === '=') {
        index += 1;
        while (/\s/.test(source[index] || '')) index += 1;
        if (source[index] === '"' || source[index] === "'") {
          quote = source[index];
          valueStart = index + 1;
          index += 1;
          while (index < source.length && source[index] !== quote) index += 1;
          if (index >= source.length) throw new SyntaxError('Unterminated HTML attribute');
          valueEnd = index;
          value = decodeHtmlEntities(source.slice(valueStart, valueEnd));
          index += 1;
        } else {
          valueStart = index;
          while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
          valueEnd = index;
          value = decodeHtmlEntities(source.slice(valueStart, valueEnd));
        }
      }
      attributes.set(name, { name, value, start: valueStart, end: valueEnd, quote });
    }
    throw new SyntaxError('Unterminated HTML start tag');
  }

  function discoverMarkupReferences(source, options = {}) {
    const references = [];
    let index = 0;
    let svgDepth = options.svg ? 1 : 0;
    while (index < source.length) {
      const open = source.indexOf('<', index);
      if (open < 0) break;
      if (source.startsWith('<!--', open)) { const end = source.indexOf('-->', open + 4); if (end < 0) throw new SyntaxError('Unterminated HTML comment'); index = end + 3; continue; }
      if (source.startsWith('</', open)) {
        const closing = source.slice(open + 2).match(/^\s*([\w:-]+)/);
        if (closing && closing[1].toLowerCase() === 'svg') svgDepth = Math.max(0, svgDepth - 1);
        const end = source.indexOf('>', open + 2);
        index = end < 0 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith('<!', open) || source.startsWith('<?', open)) { const end = source.indexOf('>', open + 2); index = end < 0 ? source.length : end + 1; continue; }
      const tag = parseHtmlStartTag(source, open);
      if (!tag) { index = open + 1; continue; }
      const inSvg = Boolean(svgDepth || tag.tagName === 'svg' || options.svg || SVG_ELEMENTS.has(tag.tagName));
      if (tag.tagName === 'svg') svgDepth += 1;
      for (const attribute of tag.attributes.values()) {
        const location = { domLocation: { tagName: tag.tagName, attribute: attribute.name }, byteRange: { start: attribute.start, end: attribute.end } };
        if (SRCSET_ATTRIBUTES.has(attribute.name)) {
          for (const reference of discoverSrcsetReferences(attribute.value, { ...options, ownerArtifact: options.ownerArtifact })) {
            reference.range = { start: attribute.start + reference.range.start, end: attribute.start + reference.range.end };
            reference.location = { ...location, byteRange: reference.range };
            references.push(reference);
          }
          continue;
        }
        if (attribute.name === 'style' || (inSvg && SVG_PAINT_ATTRIBUTES.has(attribute.name))) {
          for (const reference of discoverCssReferences(attribute.value, options)) {
            reference.syntaxKind = inSvg && attribute.name !== 'style' ? `svg-${attribute.name}` : 'html-style-attribute';
            reference.range = { start: attribute.start + reference.range.start, end: attribute.start + reference.range.end };
            reference.location = { ...location, byteRange: reference.range };
            references.push(reference);
          }
          continue;
        }
        const isSvgUrl = inSvg && SVG_URL_ATTRIBUTES.has(attribute.name);
        if (!isSvgUrl && !URL_ATTRIBUTES.has(attribute.name) && !LAZY_URL_ATTRIBUTES.has(attribute.name)) continue;
        const role = htmlRole(tag.tagName, attribute.name, tag.attributes);
        let resolvedUrl = null;
        try { resolvedUrl = resolveRawUrl(attribute.value, options.baseUrl) ?.href || null; } catch (error) {}
        references.push(createReference({
          ownerArtifact: options.ownerArtifact,
          baseUrl: options.baseUrl,
          syntaxKind: isSvgUrl ? `svg-${attribute.name}` : LAZY_URL_ATTRIBUTES.has(attribute.name) ? 'html-lazy-attribute' : 'html-url-attribute',
          rawValue: attribute.value,
          resolvedUrl,
          location,
          range: location.byteRange,
          role,
          quote: attribute.quote
        }));
      }
      index = tag.end;
      if (tag.tagName === 'style') {
        const close = source.toLowerCase().indexOf('</style', index);
        if (close >= 0) {
          const styleBaseUrl = tag.attributes.get('data-opensave-css-base') ?.value || options.baseUrl;
          for (const reference of discoverCssReferences(source.slice(index, close), { ...options, baseUrl: styleBaseUrl })) {
            reference.syntaxKind = `html-${reference.syntaxKind}`;
            reference.range = { start: index + reference.range.start, end: index + reference.range.end };
            reference.location = { domLocation: { tagName: 'style', text: true }, byteRange: reference.range };
            references.push(reference);
          }
          index = close;
        }
      } else if (tag.tagName === 'script') {
        const close = source.toLowerCase().indexOf('</script', index);
        const type = (tag.attributes.get('type') ?.value || '').toLowerCase();
        const executable = !type || type === 'module' || /(?:java|ecma)script/.test(type);
        if (close >= 0 && executable) {
          for (const reference of discoverJavaScriptReferences(source.slice(index, close), options)) {
            reference.syntaxKind = `html-${reference.syntaxKind}`;
            reference.range = { start: index + reference.range.start, end: index + reference.range.end };
            reference.location = { domLocation: { tagName: 'script', text: true }, byteRange: reference.range };
            references.push(reference);
          }
        }
        if (close >= 0) index = close;
      }
    }
    return references;
  }

  function encodeReplacement(reference, value) {
    if (!reference.quote) return value;
    if (reference.syntaxKind.includes('javascript')) return value.replace(/\\/g, '\\\\').replace(new RegExp(reference.quote, 'g'), `\\${reference.quote}`);
    return value.replace(/\\/g, '\\\\').replace(new RegExp(reference.quote, 'g'), `\\${reference.quote}`);
  }

  function rewriteReferences(source, references, resolver, baseUrl) {
    const resolved = references.map((reference) => resolver.resolve(reference, baseUrl));
    const diagnostics = resolved.filter((reference) => reference.disposition === 'blocked' || reference.disposition === 'unresolved').map((reference) => ({
      code: reference.reasonCode || 'resource-reference-unresolved',
      severity: EXECUTABLE_ROLES.has(reference.role) ? 'error' : 'warning',
      phase: 'resource-rewrite',
      message: `${reference.syntaxKind} ${reference.rawValue} was ${reference.disposition}`,
      reference
    }));
    let output = source;
    for (const reference of [...resolved].sort((left, right) => right.range.start - left.range.start)) {
      if (!reference.range || reference.replacement === reference.rawValue) continue;
      const replacement = encodeReplacement(reference, reference.replacement);
      output = `${output.slice(0, reference.range.start)}${replacement}${output.slice(reference.range.end)}`;
    }
    return { source: output, references: resolved, diagnostics };
  }

  function rewriteCss(source, options = {}) {
    return rewriteReferences(source, discoverCssReferences(source, options), options.resolver || createResolver(), options.baseUrl);
  }

  function rewriteJavaScript(source, options = {}) {
    return rewriteReferences(source, discoverJavaScriptReferences(source, options), options.resolver || createResolver(), options.baseUrl);
  }

  function rewriteHtml(source, options = {}) {
    return rewriteReferences(source, discoverMarkupReferences(source, options), options.resolver || createResolver(), options.baseUrl);
  }

  function rewriteSvg(source, options = {}) {
    return rewriteReferences(source, discoverMarkupReferences(source, { ...options, svg: true }), options.resolver || createResolver(), options.baseUrl);
  }

  const api = {
    createReference,
    createResolver,
    normalizeUrl,
    discoverCssReferences,
    discoverJavaScriptReferences,
    discoverSrcsetReferences,
    discoverHtmlReferences: discoverMarkupReferences,
    discoverSvgReferences(source, options = {}) { return discoverMarkupReferences(source, { ...options, svg: true }); },
    rewriteReferences,
    rewriteCss,
    rewriteJavaScript,
    rewriteHtml,
    rewriteSvg
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.OpenSaveResourceParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
