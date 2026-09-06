(function initDoubaoPageExtractor(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DoubaoPageExtractor = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const BLOCK_TAGS = new Set([
    "ADDRESS",
    "ARTICLE",
    "BLOCKQUOTE",
    "DD",
    "DETAILS",
    "DIV",
    "DT",
    "FIGCAPTION",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "MAIN",
    "P",
    "SECTION",
    "SUMMARY",
    "TD",
    "TH",
    "TR",
  ]);
  const CONTAINER_TAGS = new Set([
    "ARTICLE",
    "BODY",
    "DIV",
    "MAIN",
    "SECTION",
  ]);
  const SKIPPED_TAGS = new Set([
    "AREA",
    "AUDIO",
    "BUTTON",
    "CANVAS",
    "DIALOG",
    "EMBED",
    "FOOTER",
    "FORM",
    "IFRAME",
    "INPUT",
    "MENU",
    "NAV",
    "NOFRAMES",
    "NOSCRIPT",
    "OBJECT",
    "OPTION",
    "SCRIPT",
    "SELECT",
    "STYLE",
    "SVG",
    "TEXTAREA",
    "VIDEO",
  ]);
  const HARD_EXCLUDED_TOKEN = /^(?:account|actions?|ads|advert(?:isement)?|banner|breadcrumbs?|comments?|controls?|cookie|copy-actions?|dialog|drawer|dropdown|footer|menu|menubar|modal|navigation|navbar|nav|notifications?|popover|promo|recommendations?|related|samples?|share|sidebar|social|sponsor|table-of-contents|toast|toc|toolbar)$/i;
  const POSITIVE_TOKEN = /^(?:article|body|content|contentdoc|doc|doceditor|document|entry|main|page|post|reader|story|text|viewer)$/i;
  const HEADING_TAG = /^H[1-6]$/;

  function extractPage(documentObject, options = {}) {
    if (!documentObject?.body) {
      return { title: "", blocks: [], root: null, strategy: "empty" };
    }

    const environment = createEnvironment(documentObject, options);
    const rawBlocks = collectTextBlocks(documentObject.body, environment);
    if (!rawBlocks.length) {
      return {
        title: findPageTitle(documentObject, [], environment).text,
        blocks: [],
        root: documentObject.body,
        strategy: "empty",
      };
    }

    const selection = selectContentRoot(rawBlocks, documentObject.body, environment);
    const selectedBlocks = selection?.indices?.map((index) => rawBlocks[index]) || rawBlocks;
    const deduped = deduplicateBlocks(selectedBlocks.filter(isMeaningfulBlock));
    const title = findPageTitle(documentObject, deduped, environment, rawBlocks);
    const blocks = prependTitle(deduped, title);

    return {
      title: title.text || normalizeText(documentObject.title),
      blocks,
      root: selection?.element || documentObject.body,
      strategy: selection ? "scored-text-blocks" : "all-text-blocks",
    };
  }

  function createEnvironment(documentObject, options) {
    const windowObject = options.window || documentObject.defaultView || globalThis.window;
    const visibilityCache = new WeakMap();
    const rectCache = new WeakMap();
    return {
      document: documentObject,
      window: windowObject,
      isVisible(element) {
        if (!element || element.nodeType !== ELEMENT_NODE) {
          return true;
        }
        if (visibilityCache.has(element)) {
          return visibilityCache.get(element);
        }
        const result = isElementVisible(element, windowObject, options);
        visibilityCache.set(element, result);
        return result;
      },
      getRect(element) {
        if (!element || element.nodeType !== ELEMENT_NODE) {
          return emptyRect();
        }
        if (rectCache.has(element)) {
          return rectCache.get(element);
        }
        let result = emptyRect();
        try {
          result = normalizeRect(
            typeof options.getRect === "function"
              ? options.getRect(element)
              : element.getBoundingClientRect?.(),
          );
        } catch (_error) {
          result = emptyRect();
        }
        rectCache.set(element, result);
        return result;
      },
    };
  }

  function collectTextBlocks(startingNode, environment) {
    const groups = new Map();
    const ordered = [];
    let order = 0;

    function visit(node) {
      if (!node) {
        return;
      }
      if (node.nodeType === TEXT_NODE) {
        const text = normalizeText(node.nodeValue);
        if (!text) {
          return;
        }
        const block = findBlockElement(node.parentElement, startingNode, environment);
        if (!block) {
          return;
        }
        let group = groups.get(block);
        if (!group) {
          group = {
            node: block,
            parts: [],
            linkChars: 0,
            order: order++,
            kind: blockKind(block),
          };
          groups.set(block, group);
          ordered.push(group);
        }
        group.parts.push(text);
        if (closestAcrossLightDom(node.parentElement, "A", block)) {
          group.linkChars += text.length;
        }
        return;
      }
      if (node.nodeType !== ELEMENT_NODE && node !== startingNode && !node.host) {
        return;
      }

      if (node.nodeType === ELEMENT_NODE) {
        if (node !== startingNode && (isExcludedElement(node) || !environment.isVisible(node))) {
          return;
        }
      }

      for (const child of Array.from(node.childNodes || [])) {
        visit(child);
      }

      // Open shadow roots are inspectable from an extension's isolated world.
      // Visit them in addition to light DOM and let the text de-duplicator handle
      // slotted content that a component exposes twice.
      if (node.nodeType === ELEMENT_NODE && node.shadowRoot) {
        visit(node.shadowRoot);
      }
    }

    visit(startingNode);
    return ordered
      .map((group) => ({
        text: joinInlineParts(group.parts),
        node: group.node,
        nodes: [group.node],
        linkChars: group.linkChars,
        order: group.order,
        kind: group.kind,
      }))
      .filter(isMeaningfulBlock);
  }

  function findBlockElement(element, boundary, environment) {
    if (!element) {
      return null;
    }

    const row = closestAcrossLightDom(element, "TR", boundary);
    if (row && environment.isVisible(row)) {
      return row;
    }

    let current = element;
    let fallback = null;
    while (current) {
      if (isExcludedElement(current) || !environment.isVisible(current)) {
        return null;
      }
      if (!fallback && current.nodeType === ELEMENT_NODE) {
        fallback = current;
      }
      if (BLOCK_TAGS.has(current.tagName)) {
        return current;
      }
      if (current === boundary) {
        break;
      }
      current = parentElementAcrossShadow(current);
    }
    return fallback;
  }

  function selectContentRoot(blocks, body, environment) {
    const candidates = new Map();

    blocks.forEach((block, index) => {
      const visited = new Set();
      let current = block.node;
      while (current && !visited.has(current)) {
        visited.add(current);
        if (isContainerCandidate(current)) {
          let candidate = candidates.get(current);
          if (!candidate) {
            candidate = {
              element: current,
              indices: [],
              textLength: 0,
              linkChars: 0,
              depth: elementDepth(current),
            };
            candidates.set(current, candidate);
          }
          candidate.indices.push(index);
          candidate.textLength += block.text.length;
          candidate.linkChars += Math.min(block.linkChars, block.text.length);
        }
        if (current === body) {
          break;
        }
        current = parentElementAcrossShadow(current);
      }
    });

    const bodyCandidate = candidates.get(body);
    const totalText = bodyCandidate?.textLength || blocks.reduce((sum, block) => sum + block.text.length, 0);
    const minimumCandidateText = Math.min(240, Math.max(60, totalText * 0.12));
    let best = null;

    for (const candidate of candidates.values()) {
      if (candidate.textLength < minimumCandidateText || candidate.indices.length < 2) {
        continue;
      }
      candidate.score = scoreCandidate(candidate, totalText, environment);
      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }

    return best || bodyCandidate || null;
  }

  function scoreCandidate(candidate, totalText, environment) {
    const element = candidate.element;
    const identityTokens = getIdentityTokens(element);
    const positiveCount = identityTokens.filter((token) => POSITIVE_TOKEN.test(token) || token.startsWith("doceditor")).length;
    const linkDensity = candidate.textLength ? candidate.linkChars / candidate.textLength : 1;
    const coverage = totalText ? candidate.textLength / totalText : 0;
    const semanticBonus = element.tagName === "ARTICLE" || element.tagName === "MAIN" || element.getAttribute?.("role") === "main" ? 180 : 0;
    const positiveBonus = Math.min(positiveCount, 2) * 75;
    const bodyPenalty = element.tagName === "BODY" ? 55 : 0;
    const rect = environment.getRect(element);
    const viewportWidth = Number(environment.window?.innerWidth) || 0;
    const narrowPenalty = rect.width > 0 && viewportWidth > 0 && rect.width < Math.min(240, viewportWidth * 0.2) ? 90 : 0;
    const fixedPenalty = isFixedElement(element, environment.window) ? 220 : 0;

    return (
      Math.log2(candidate.textLength + 1) * 92 +
      Math.sqrt(Math.max(coverage, 0)) * 260 +
      Math.min(candidate.indices.length, 40) * 2.5 +
      semanticBonus +
      positiveBonus +
      Math.min(candidate.depth, 24) * 2.5 -
      linkDensity * 620 -
      bodyPenalty -
      narrowPenalty -
      fixedPenalty
    );
  }

  function deduplicateBlocks(blocks) {
    const seenLong = new Set();
    const result = [];
    let previousKey = "";

    for (const block of blocks.sort((left, right) => left.order - right.order)) {
      const key = canonicalText(block.text);
      if (!key || key === previousKey) {
        continue;
      }
      if (key.length >= 24 && seenLong.has(key)) {
        continue;
      }
      if (key.length >= 24) {
        seenLong.add(key);
      }
      result.push(block);
      previousKey = key;
    }
    return result;
  }

  function findPageTitle(documentObject, blocks, environment, sourceBlocks = blocks) {
    const headings = blocks.filter((block) => block.kind === "heading" && block.text.length <= 180);
    let titleBlock = headings.find((block) => !isExcludedElement(block.node));
    if (!titleBlock) {
      for (const heading of Array.from(documentObject.querySelectorAll?.("h1") || [])) {
        if (!isExcludedElement(heading) && environment.isVisible(heading)) {
          const text = normalizeText(heading.innerText || heading.textContent);
          if (containsReadableCharacter(text) && text.length <= 180) {
            titleBlock = { text, node: heading, nodes: [heading], kind: "title", order: -1, linkChars: 0 };
            break;
          }
        }
      }
    }

    const metadataTitle = normalizeText(
      documentObject.querySelector?.("meta[property='og:title']")?.getAttribute("content") ||
      documentObject.querySelector?.("meta[name='twitter:title']")?.getAttribute("content"),
    );
    const browserTitle = cleanDocumentTitle(documentObject.title);
    const text = titleBlock?.text || metadataTitle || browserTitle;
    if (!text) {
      return { text: "", node: null, nodes: [], kind: "title", order: -1, linkChars: 0 };
    }

    const exactSource = sourceBlocks.find((block) => canonicalText(block.text) === canonicalText(text));
    return {
      text,
      node: exactSource?.node || titleBlock?.node || null,
      nodes: exactSource?.nodes || titleBlock?.nodes || [],
      kind: "title",
      order: -1,
      linkChars: 0,
    };
  }

  function prependTitle(blocks, title) {
    if (!title.text || blocks.some((block) => canonicalText(block.text) === canonicalText(title.text))) {
      return blocks;
    }
    return [title, ...blocks];
  }

  function segmentBlocks(blocks, options = {}) {
    const maxLength = Math.max(80, Number(options.maxLength) || 280);
    const firstMaxLength = Math.min(
      maxLength,
      Math.max(60, Number(options.firstMaxLength) || 140),
    );
    const targetLength = Math.min(maxLength, Math.max(48, Number(options.targetLength) || 120));
    const segments = [];
    let pending = null;

    const flush = () => {
      if (pending?.text) {
        segments.push(pending);
      }
      pending = null;
    };

    for (const block of blocks) {
      const pieces = splitLongText(block.text, maxLength);
      pieces.forEach((text, pieceIndex) => {
        const current = {
          text,
          node: block.node || null,
          nodes: Array.from(new Set(block.nodes || (block.node ? [block.node] : []))),
          kind: block.kind,
        };
        if (!pending) {
          pending = current;
          return;
        }

        const separator = blockSeparator(pending.text, current.text, current.kind);
        const mergedLength = pending.text.length + separator.length + current.text.length;
        const activeMaxLength = segments.length === 0 ? firstMaxLength : maxLength;
        const shouldMerge = mergedLength <= activeMaxLength && (
          pending.text.length < targetLength ||
          current.text.length < 36 ||
          pending.kind === "heading" ||
          pending.kind === "title"
        );

        if (!shouldMerge || pieceIndex > 0) {
          flush();
          pending = current;
          return;
        }

        pending.text += separator + current.text;
        pending.nodes = Array.from(new Set([...pending.nodes, ...current.nodes]));
        pending.node ||= current.node;
        pending.kind = "group";
      });
    }
    flush();
    return segments;
  }

  function splitLongText(input, maxLength = 280) {
    const text = normalizeText(input);
    if (!text) {
      return [];
    }
    if (text.length <= maxLength) {
      return [text];
    }

    const sentences = text.match(/[^。！？!?；;.!?\n]+[。！？!?；;.!?\n]?/g) || [text];
    const parts = [];
    let pending = "";
    for (const sentence of sentences) {
      const piece = normalizeText(sentence);
      if (!piece) {
        continue;
      }
      if (pending && pending.length + piece.length <= maxLength) {
        pending += piece;
        continue;
      }
      if (pending) {
        parts.push(pending);
        pending = "";
      }
      if (piece.length <= maxLength) {
        pending = piece;
        continue;
      }
      for (let offset = 0; offset < piece.length; offset += maxLength) {
        const slice = piece.slice(offset, offset + maxLength);
        if (slice.length === maxLength) {
          parts.push(slice);
        } else {
          pending = slice;
        }
      }
    }
    if (pending) {
      parts.push(pending);
    }
    return parts;
  }

  function getSelectionText(documentObject, windowObject = documentObject?.defaultView || globalThis.window) {
    const direct = selectionValue(windowObject?.getSelection?.());
    if (direct) {
      return direct;
    }

    const seen = new Set();
    const visit = (node) => {
      if (!node || seen.has(node)) {
        return "";
      }
      seen.add(node);
      if (node.shadowRoot) {
        const shadowSelection = selectionValue(node.shadowRoot.getSelection?.());
        if (shadowSelection) {
          return shadowSelection;
        }
        const nested = visit(node.shadowRoot);
        if (nested) {
          return nested;
        }
      }
      for (const child of Array.from(node.children || [])) {
        const nested = visit(child);
        if (nested) {
          return nested;
        }
      }
      return "";
    };
    return visit(documentObject?.documentElement);
  }

  function selectionValue(selection) {
    if (!selection || selection.isCollapsed) {
      return "";
    }
    return normalizeText(selection.toString());
  }

  function isElementVisible(element, windowObject, options) {
    if (
      element.hasAttribute?.("hidden") ||
      element.hasAttribute?.("inert") ||
      element.getAttribute?.("aria-hidden") === "true" ||
      element.getAttribute?.("hidden") === "until-found"
    ) {
      return false;
    }
    const details = element.closest?.("details:not([open])");
    if (details && element.tagName !== "SUMMARY" && !element.closest?.("summary")) {
      return false;
    }
    if (typeof options.isVisible === "function") {
      return options.isVisible(element) !== false;
    }

    try {
      const style = windowObject?.getComputedStyle?.(element);
      if (
        style?.display === "none" ||
        style?.visibility === "hidden" ||
        style?.visibility === "collapse" ||
        Number.parseFloat(style?.opacity || "1") === 0
      ) {
        return false;
      }
      if (style?.display === "contents") {
        return true;
      }
    } catch (_error) {
      // A detached or cross-document element can reject style inspection.
    }

    try {
      const rect = element.getBoundingClientRect?.();
      const clientRects = element.getClientRects?.();
      if (rect && rect.width === 0 && rect.height === 0 && clientRects?.length === 0) {
        return element.tagName === "BODY" || element.tagName === "HTML";
      }
    } catch (_error) {
      return true;
    }
    return true;
  }

  function isExcludedElement(element) {
    if (!element || element.nodeType !== ELEMENT_NODE) {
      return false;
    }
    if (element.id === "doubao-reader-root") {
      return true;
    }
    if (SKIPPED_TAGS.has(element.tagName)) {
      return true;
    }
    if (element.tagName === "PRE") {
      return true;
    }
    if (element.tagName === "CODE" && !isInlineCode(element)) {
      return true;
    }
    const role = normalizeText(element.getAttribute?.("role")).toLowerCase();
    if (["alertdialog", "dialog", "menu", "menubar", "navigation", "toolbar"].includes(role)) {
      return true;
    }
    const label = normalizeText(element.getAttribute?.("aria-label")).toLowerCase();
    if (/\b(?:menu|navigation|sidebar|table of contents)\b/.test(label)) {
      return true;
    }
    const tokens = getIdentityTokens(element);
    return tokens.some((token) => HARD_EXCLUDED_TOKEN.test(token));
  }

  function isInlineCode(element) {
    const parentTag = element.parentElement?.tagName;
    return ["A", "BLOCKQUOTE", "DD", "DIV", "DT", "FIGCAPTION", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "P", "SPAN", "TD", "TH"].includes(parentTag) && normalizeText(element.textContent).length < 160;
  }

  function isMeaningfulBlock(block) {
    const text = normalizeText(block?.text);
    if (!containsReadableCharacter(text)) {
      return false;
    }
    if (block.kind === "heading" || block.kind === "title") {
      return text.length >= 2;
    }
    return text.length >= 3;
  }

  function isContainerCandidate(element) {
    return element?.nodeType === ELEMENT_NODE && (
      CONTAINER_TAGS.has(element.tagName) ||
      String(element.tagName || "").includes("-") ||
      element.getAttribute?.("role") === "main"
    );
  }

  function parentElementAcrossShadow(node) {
    if (node?.parentElement) {
      return node.parentElement;
    }
    const rootNode = node?.getRootNode?.();
    return rootNode?.host || null;
  }

  function closestAcrossLightDom(element, tagName, boundary) {
    let current = element;
    while (current) {
      if (current.tagName === tagName) {
        return current;
      }
      if (current === boundary) {
        return null;
      }
      current = current.parentElement;
    }
    return null;
  }

  function getIdentityTokens(element) {
    const className = typeof element?.className === "string"
      ? element.className
      : element?.getAttribute?.("class");
    const classTokens = String(className || "")
      .split(/\s+/)
      // Some editors encode a full URL into a class name. Treating pieces of
      // that URL as semantic class tokens creates accidental matches (for
      // example a percent-encoded byte named "ad").
      .filter((value) => value.length <= 80 && !/[:/%]/.test(value));
    const values = [element?.id, ...classTokens, element?.getAttribute?.("role")];
    return values
      .filter(Boolean)
      .flatMap((value) => String(value)
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^\p{L}\p{N}]+/u))
      .map((value) => value.toLowerCase())
      .filter(Boolean);
  }

  function elementDepth(element) {
    let depth = 0;
    let current = element;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      depth += 1;
      current = parentElementAcrossShadow(current);
    }
    return depth;
  }

  function isFixedElement(element, windowObject) {
    try {
      const position = windowObject?.getComputedStyle?.(element)?.position;
      return position === "fixed" || position === "sticky";
    } catch (_error) {
      return false;
    }
  }

  function blockKind(element) {
    if (HEADING_TAG.test(element?.tagName || "")) {
      return "heading";
    }
    if (element?.tagName === "TR") {
      return "table-row";
    }
    if (element?.tagName === "LI" || element?.tagName === "DD" || element?.tagName === "DT") {
      return "list-item";
    }
    return "paragraph";
  }

  function cleanDocumentTitle(value) {
    const title = normalizeText(value);
    if (!title) {
      return "";
    }
    for (const separator of ["--", " | ", " — ", " – ", " - "]) {
      const head = title.split(separator)[0]?.trim();
      if (head && head.length >= 2) {
        return head;
      }
    }
    return title;
  }

  function blockSeparator(previous, next, nextKind) {
    if (/^[,.;:!?，。！？；：、)\]}]/.test(next)) {
      return "";
    }
    if (/[。！？!?；;:]$/.test(previous)) {
      return " ";
    }
    if (nextKind === "table-row") {
      return "；";
    }
    return "。";
  }

  function joinInlineParts(parts) {
    let result = "";
    for (const rawPart of parts) {
      const part = normalizeText(rawPart);
      if (!part) {
        continue;
      }
      if (!result) {
        result = part;
        continue;
      }
      const noSpace = /[\p{L}\p{N}]$/u.test(result) && /^[\p{L}\p{N}]/u.test(part)
        ? endsWithCjk(result) && startsWithCjk(part)
        : /^[,.;:!?，。！？；：、)\]}]/.test(part) || /[(\[{]$/.test(result);
      result += noSpace ? part : ` ${part}`;
    }
    return normalizeText(result);
  }

  function endsWithCjk(value) {
    return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(value);
  }

  function startsWithCjk(value) {
    return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
  }

  function containsReadableCharacter(value) {
    return /[\p{L}\p{N}]/u.test(value || "");
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function canonicalText(value) {
    return normalizeText(value)
      .toLocaleLowerCase()
      .replace(/\s+/g, " ");
  }

  function normalizeRect(rect) {
    return {
      x: Number(rect?.x ?? rect?.left) || 0,
      y: Number(rect?.y ?? rect?.top) || 0,
      width: Number(rect?.width) || 0,
      height: Number(rect?.height) || 0,
    };
  }

  function emptyRect() {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  return Object.freeze({
    extractPage,
    getSelectionText,
    normalizeText,
    segmentBlocks,
    splitLongText,
  });
});
