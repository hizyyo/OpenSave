(function initializeLiveDomState(globalScope) {
  'use strict';

  const SNAPSHOT_VERSION = 1;

  async function serializeLiveDomState(options = {}) {
    const root = options.root || document.documentElement;
    const selection = Boolean(options.selection);
    const maxEmbeddedBytes = options.maxEmbeddedBytes || 4 * 1024 * 1024;
    const maxCssBytes = options.maxCssBytes || 1024 * 1024;
    const diagnostics = [];
    const summary = {
      formValues: 0,
      redactedFields: 0,
      disclosures: 0,
      shadowRoots: 0,
      adoptedStyleSheets: 0,
      cssomStyleSheets: 0,
      canvases: 0,
      blobUrls: 0
    };
    const blobValues = new Map();
    let cssBytes = 0;

    const addDiagnostic = (code, reason, count = 1) => {
      const existing = diagnostics.find((item) => item.code === code && item.reason === reason);
      if (existing) existing.count += count;
      else diagnostics.push({ code, reason, count });
    };

    const isSensitiveField = (element) => {
      const type = (element.getAttribute('type') || '').toLowerCase();
      const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
      const fieldName = [element.getAttribute('name'), element.id, element.getAttribute('aria-label')].filter(Boolean).join(' ');
      return type === 'password'
        || type === 'file'
        || type === 'hidden'
        || /(?:^|\s)(?:cc-|current-password|new-password|one-time-code|webauthn)/.test(autocomplete)
        || /(?:^|[_\-.\s])(?:access[_-]?token|api[_-]?key|auth|card(?:holder|number)?|client[_-]?secret|credential|csrf|cvc|cvv|password|passcode|pin|refresh[_-]?token|secret|session(?:id)?|token|xsrf)(?:$|[_\-.\s])/i.test(fieldName)
        || element.hasAttribute('data-private')
        || element.hasAttribute('data-sensitive')
        || element.hasAttribute('data-opensave-private');
    };

    const redactField = (source, clone) => {
      clone.setAttribute('data-opensave-redacted', '');
      clone.removeAttribute('value');
      clone.removeAttribute('checked');
      clone.removeAttribute('src');
      if (source.tagName === 'TEXTAREA') clone.textContent = '';
      if (source.tagName === 'SELECT') clone.querySelectorAll('option').forEach((option) => {
        option.removeAttribute('selected');
        option.removeAttribute('value');
        option.textContent = '';
      });
      if (source.tagName === 'OPTION') clone.textContent = '';
      summary.redactedFields += 1;
    };

    const copyFormState = (source, clone) => {
      if (!/^(?:INPUT|TEXTAREA|SELECT|OPTION)$/.test(source.tagName)) return;
      if (isSensitiveField(source) || source.closest('[data-private], [data-sensitive], [data-opensave-private]')) {
        redactField(source, clone);
        return;
      }
      if (source.tagName === 'INPUT') {
        const type = (source.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          clone.toggleAttribute('checked', Boolean(source.checked));
          clone.toggleAttribute('data-opensave-indeterminate', Boolean(source.indeterminate));
        } else if (type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'image') {
          clone.setAttribute('value', source.value || '');
        }
      } else if (source.tagName === 'TEXTAREA') {
        clone.textContent = source.value || '';
      } else if (source.tagName === 'SELECT') {
        const sourceOptions = [...source.options];
        [...clone.options].forEach((option, index) => option.toggleAttribute('selected', Boolean(sourceOptions[index] && sourceOptions[index].selected)));
      } else if (source.tagName === 'OPTION') {
        clone.toggleAttribute('selected', Boolean(source.selected));
      }
      summary.formValues += 1;
    };

    const copyDisclosureState = (source, clone) => {
      if (source.tagName === 'DETAILS' || source.tagName === 'DIALOG') {
        clone.toggleAttribute('open', Boolean(source.open));
        if (source.open) summary.disclosures += 1;
      }
      try {
        if (source.matches(':popover-open')) {
          clone.setAttribute('data-opensave-popover-open', '');
          summary.disclosures += 1;
        }
      } catch (error) {
        // Older pages may reject the selector even when the popover API is absent.
      }
    };

    const blobToDataUrl = async (value) => {
      if (blobValues.has(value)) return blobValues.get(value);
      const pending = (async () => {
        try {
          const response = await fetch(value);
          const blob = await response.blob();
          if (blob.size > maxEmbeddedBytes) {
            addDiagnostic('blob-url-too-large', 'Blob-backed DOM resource exceeded the embedding limit');
            return null;
          }
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('Blob read failed'));
            reader.readAsDataURL(blob);
          });
        } catch (error) {
          addDiagnostic('blob-url-unavailable', 'Blob-backed DOM resource could not be read');
          return null;
        }
      })();
      blobValues.set(value, pending);
      return pending;
    };

    const materializeBlobReferences = async (clone) => {
      for (const attribute of ['src', 'href', 'poster', 'data']) {
        const value = clone.getAttribute && clone.getAttribute(attribute);
        if (!value || !/^blob:/i.test(value)) continue;
        const dataUrl = await blobToDataUrl(value);
        if (dataUrl) {
          clone.setAttribute(attribute, dataUrl);
          summary.blobUrls += 1;
        } else {
          clone.removeAttribute(attribute);
        }
      }
      for (const attribute of ['style', 'srcset']) {
        const value = clone.getAttribute && clone.getAttribute(attribute);
        if (!value || !value.includes('blob:')) continue;
        const urls = [...new Set(value.match(/blob:[^\s"')>,]+/g) || [])];
        let rewritten = value;
        for (const url of urls) {
          const dataUrl = await blobToDataUrl(url);
          rewritten = rewritten.split(url).join(dataUrl || 'data:,');
          if (dataUrl) summary.blobUrls += 1;
        }
        clone.setAttribute(attribute, rewritten);
      }
    };

    const rulesFor = (sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      } catch (error) {
        return null;
      }
    };

    const createMaterializedStyle = (ownerDocument, css, kind, baseUrl) => {
      if (!css) return null;
      const bytes = new TextEncoder().encode(css).byteLength;
      if (cssBytes + bytes > maxCssBytes) {
        addDiagnostic('cssom-size-limit', 'Materialized CSSOM rules exceeded the snapshot limit');
        return null;
      }
      cssBytes += bytes;
      const style = ownerDocument.createElement('style');
      style.setAttribute('data-opensave-style', kind);
      if (baseUrl) style.setAttribute('data-opensave-css-base', baseUrl);
      style.textContent = css;
      return style;
    };

    const materializeAdoptedSheets = (sourceRoot, cloneContainer) => {
      const sheets = sourceRoot.adoptedStyleSheets || [];
      for (const sheet of sheets) {
        const css = rulesFor(sheet);
        if (css == null) {
          addDiagnostic('adopted-stylesheet-unavailable', 'Adopted stylesheet rules could not be read');
          continue;
        }
        const style = createMaterializedStyle(cloneContainer.ownerDocument || document, css, 'adopted', sheet.href || '');
        if (!style) continue;
        cloneContainer.prepend(style);
        summary.adoptedStyleSheets += 1;
      }
    };

    const materializeElementStyleSheet = (source, clone) => {
      if (source.tagName === 'STYLE' && source.sheet) {
        const css = rulesFor(source.sheet);
        if (css != null && css !== source.textContent) {
          clone.textContent = css;
          clone.setAttribute('data-opensave-style', 'cssom');
          summary.cssomStyleSheets += 1;
        }
        return;
      }
      if (source.tagName !== 'LINK' || !source.sheet || !/(?:^|\s)stylesheet(?:\s|$)/i.test(source.rel || '')) return;
      const css = rulesFor(source.sheet);
      if (css == null) return;
      const style = createMaterializedStyle(clone.ownerDocument, css, 'linked-cssom', source.sheet.href || source.href || '');
      if (!style) return;
      clone.after(style);
      summary.cssomStyleSheets += 1;
    };

    const captureCanvas = (source, clone) => {
      if (source.tagName !== 'CANVAS') return;
      try {
        const dataUrl = source.toDataURL('image/png');
        if (!dataUrl || dataUrl.length > maxEmbeddedBytes * 1.4) {
          addDiagnostic('canvas-too-large', 'Canvas bitmap exceeded the embedding limit');
          return;
        }
        clone.setAttribute('data-opensave-canvas-fallback', '');
        clone.setAttribute('data-opensave-canvas-width', String(source.width));
        clone.setAttribute('data-opensave-canvas-height', String(source.height));
        const background = `background-image:url("${dataUrl}");background-size:100% 100%;background-repeat:no-repeat;`;
        clone.setAttribute('style', `${clone.getAttribute('style') || ''}${background}`);
        summary.canvases += 1;
      } catch (error) {
        addDiagnostic('canvas-unavailable', 'Canvas bitmap could not be serialized');
      }
    };

    const processElement = async (source, clone) => {
      copyFormState(source, clone);
      copyDisclosureState(source, clone);
      captureCanvas(source, clone);
      await materializeBlobReferences(clone);
      materializeElementStyleSheet(source, clone);
      if (!source.shadowRoot) return;

      const shadowClone = clone.ownerDocument.createDocumentFragment();
      for (const child of source.shadowRoot.childNodes) shadowClone.append(child.cloneNode(true));
      await processRoot(source.shadowRoot, shadowClone);
      materializeAdoptedSheets(source.shadowRoot, shadowClone);
      const template = clone.ownerDocument.createElement('template');
      template.setAttribute('data-opensave-shadowroot', 'open');
      template.content.append(shadowClone);
      clone.append(template);
      summary.shadowRoots += 1;
    };

    const processRoot = async (sourceRoot, cloneRoot) => {
      const sourceElements = [...sourceRoot.querySelectorAll('*')];
      const cloneElements = [...cloneRoot.querySelectorAll('*')];
      for (let index = 0; index < sourceElements.length; index += 1) {
        await processElement(sourceElements[index], cloneElements[index]);
      }
    };

    if (options.closedShadowRoots) {
      addDiagnostic('closed-shadow-root-unavailable', 'Closed shadow-root content was not serialized', options.closedShadowRoots);
    }

    const clone = root.cloneNode(true);
    if (root.nodeType === Node.ELEMENT_NODE) await processElement(root, clone);
    await processRoot(root, clone);

    if (selection) {
      let context = clone;
      let parent = root.parentElement;
      while (parent && parent !== document.body) {
        const shell = parent.cloneNode(false);
        shell.append(context);
        context = shell;
        parent = parent.parentElement;
      }
      const headContainer = document.createElement('head');
      for (const source of document.head.querySelectorAll('base, meta[charset], meta[name="viewport"], link[rel~="stylesheet"], style')) {
        const headClone = source.cloneNode(true);
        await processElement(source, headClone);
        headContainer.append(headClone);
      }
      materializeAdoptedSheets(document, headContainer);
      return {
        version: 1,
        pageUrl: location.href,
        title: document.title || 'selected-element',
        bodyClass: String(document.body.className || ''),
        head: headContainer.innerHTML,
        html: context.outerHTML,
        summary,
        diagnostics
      };
    }

    const cloneHead = clone.querySelector('head');
    if (cloneHead) materializeAdoptedSheets(document, cloneHead);
    return {
      version: 1,
      pageUrl: location.href,
      title: document.title || '',
      html: `<!doctype html>${clone.outerHTML}`,
      summary,
      diagnostics
    };
  }

  const serializerSource = () => serializeLiveDomState.toString();
  const expression = (options = {}) => `(${serializerSource()})(${JSON.stringify(options)})`;

  const api = { SNAPSHOT_VERSION, serializerSource, expression };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.OpenSaveLiveDomState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
