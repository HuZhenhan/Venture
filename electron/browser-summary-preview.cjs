'use strict';

// 提取页面核心文字内容：分块摘录可见文本，剔除图片/按钮/脚本等非文本节点。
const SUMMARY_PREVIEW_SCRIPT = `
(() => {
  const ROOT_ID = 'venture-summary-preview';
  const STYLE_ID = 'venture-summary-preview-style';
  const existing = document.getElementById(ROOT_ID);
  if (existing) existing.remove();
  document.getElementById(STYLE_ID)?.remove();

  // ── 摘取动画样式 ──────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = \`
    @keyframes venture-summary-enter {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes venture-summary-scan {
      0% { transform: translateY(-14vh); opacity: 0; }
      10% { opacity: 1; }
      88% { opacity: 1; }
      100% { transform: translateY(114vh); opacity: 0; }
    }
    @keyframes venture-summary-breathe {
      0%, 100% { opacity: .46; transform: scale(.985); }
      50% { opacity: .88; transform: scale(1); }
    }
    @keyframes venture-summary-dot {
      0%, 100% { transform: scale(.72); opacity: .45; }
      50% { transform: scale(1); opacity: 1; }
    }
    #\${ROOT_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      overflow: hidden;
      pointer-events: none;
      opacity: 0;
      color-scheme: dark;
      background:
        radial-gradient(circle at 50% 38%, rgba(114, 103, 255, .08), transparent 46%),
        rgba(8, 10, 18, .16);
      box-shadow: inset 0 0 90px rgba(17, 20, 42, .2);
      animation: venture-summary-enter .36s cubic-bezier(.22, 1, .36, 1) forwards;
      transition: opacity .62s cubic-bezier(.22, 1, .36, 1);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #\${ROOT_ID}[data-leaving="true"] { opacity: 0; }
    #\${ROOT_ID} .venture-summary-frame {
      position: absolute;
      inset: 18px;
      border: 1px solid rgba(174, 185, 255, .28);
      border-radius: 18px;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .04), 0 0 42px rgba(94, 89, 255, .08);
      animation: venture-summary-breathe 2.2s ease-in-out infinite;
    }
    #\${ROOT_ID} .venture-summary-frame::before,
    #\${ROOT_ID} .venture-summary-frame::after {
      content: '';
      position: absolute;
      width: 38px;
      height: 38px;
      border-color: rgba(184, 194, 255, .72);
      border-style: solid;
    }
    #\${ROOT_ID} .venture-summary-frame::before {
      left: -1px;
      top: -1px;
      border-width: 2px 0 0 2px;
      border-radius: 18px 0 0 0;
    }
    #\${ROOT_ID} .venture-summary-frame::after {
      right: -1px;
      bottom: -1px;
      border-width: 0 2px 2px 0;
      border-radius: 0 0 18px 0;
    }
    #\${ROOT_ID} .venture-summary-scan {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 92px;
      background: linear-gradient(180deg, transparent, rgba(132, 146, 255, .11) 54%, transparent);
      border-bottom: 1px solid rgba(186, 197, 255, .7);
      filter: drop-shadow(0 8px 14px rgba(95, 107, 255, .2));
      animation: venture-summary-scan 2.65s cubic-bezier(.45, 0, .25, 1) infinite;
    }
    #\${ROOT_ID} .venture-summary-status {
      position: absolute;
      top: 34px;
      left: 50%;
      display: flex;
      align-items: center;
      gap: 9px;
      transform: translateX(-50%);
      padding: 8px 13px 8px 10px;
      border: 1px solid rgba(255, 255, 255, .13);
      border-radius: 999px;
      background: rgba(17, 20, 32, .74);
      box-shadow: 0 12px 38px rgba(4, 6, 14, .22), inset 0 1px rgba(255, 255, 255, .08);
      backdrop-filter: blur(16px) saturate(130%);
      -webkit-backdrop-filter: blur(16px) saturate(130%);
      color: rgba(245, 247, 255, .92);
      font-size: 12px;
      font-weight: 550;
      letter-spacing: .02em;
      white-space: nowrap;
    }
    #\${ROOT_ID} .venture-summary-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #aeb8ff;
      box-shadow: 0 0 12px rgba(152, 164, 255, .9);
      animation: venture-summary-dot 1.15s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      #\${ROOT_ID}, #\${ROOT_ID} * { animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
    }
  \`;

  // ── 注入动画 UI ────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-label', '正在摘取网页核心信息');

  const frame = document.createElement('div');
  frame.className = 'venture-summary-frame';
  const scan = document.createElement('div');
  scan.className = 'venture-summary-scan';
  const status = document.createElement('div');
  status.className = 'venture-summary-status';
  const dot = document.createElement('span');
  dot.className = 'venture-summary-dot';
  const label = document.createElement('span');
  label.textContent = '正在摘取核心信息';
  status.append(dot, label);
  root.append(frame, scan, status);
  document.documentElement.append(style, root);

  // ── 内容摘取逻辑 ────────────────────────────────────────────────────────────
  // 跳过这些非文本/交互节点：图片、按钮、脚本、样式、表单控件、媒体等
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS',
    'IFRAME', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP',
    'TEMPLATE', 'OBJECT', 'EMBED', 'LINK', 'META', 'HEAD', 'MAP', 'AREA',
  ]);

  // 块级文本标签：遇到时按其语义分块，不再向下递归
  const BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'FIGCAPTION',
    'DL', 'DT', 'DD', 'DETAILS', 'SUMMARY', 'FIGURE', 'ADDRESS', 'ARTICLE',
    'SECTION', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'MAIN', 'FORM', 'FIELDSET',
  ]);

  const MAX_CHUNKS = 600;          // 单页最多摘取的块数，防止巨型页面
  const MAX_CHUNK_LEN = 4000;      // 单块最大字符数

  // 判断元素是否对用户可见（非 display:none / 非零尺寸 / 非 hidden）
  function isRendered(el) {
    if (el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  const chunks = [];
  let counter = 0;
  const seenText = new Set();

  function addChunk(type, content, level) {
    if (chunks.length >= MAX_CHUNKS) return;
    const text = String(content || '').replace(/[\\t\\r\\n\\f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    if (!text || text.length < 2) return;
    if (seenText.has(text)) return;
    seenText.add(text);
    chunks.push({
      id: 'chunk-' + (counter++),
      type: type,
      level: level || undefined,
      content: text.length > MAX_CHUNK_LEN ? text.slice(0, MAX_CHUNK_LEN) + '…' : text,
    });
  }

  // 取元素的可见文本（innerText 会尊重可见性并保留换行）
  function textOf(el) {
    const t = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
    return t || '';
  }

  function hasBlockChild(el) {
    for (let i = 0; i < el.children.length; i++) {
      if (BLOCK_TAGS.has(el.children[i].tagName)) return true;
    }
    return false;
  }

  function walk(el) {
    if (el.nodeType !== Node.ELEMENT_NODE) return;
    if (chunks.length >= MAX_CHUNKS) return;
    const tag = el.tagName;

    if (SKIP_TAGS.has(tag)) return;
    if (!isRendered(el)) return;

    // 标题：按级别分块
    const headingMatch = tag.match(/^H([1-6])$/);
    if (headingMatch) {
      addChunk('heading', textOf(el), parseInt(headingMatch[1], 10));
      return;
    }

    // 段落 / 说明文字
    if (tag === 'P' || tag === 'CAPTION' || tag === 'FIGCAPTION' ||
        tag === 'SUMMARY' || tag === 'DD' || tag === 'DT' || tag === 'ADDRESS') {
      addChunk('text', textOf(el));
      return;
    }

    // 代码块
    if (tag === 'PRE') {
      addChunk('code', textOf(el));
      return;
    }

    // 引用
    if (tag === 'BLOCKQUOTE') {
      addChunk('quote', textOf(el));
      return;
    }

    // 列表：合并为单个 list 块，每项一行
    if (tag === 'UL' || tag === 'OL') {
      const items = [];
      for (let i = 0; i < el.children.length; i++) {
        const li = el.children[i];
        if (li.tagName !== 'LI') continue;
        if (!isRendered(li)) continue;
        const t = textOf(li).replace(/\\s+/g, ' ').trim();
        if (t) items.push(t);
      }
      if (items.length) addChunk('list', items.join('\\n'));
      return;
    }

    // 表格单元格
    if (tag === 'TD' || tag === 'TH') {
      addChunk('text', textOf(el));
      return;
    }

    // 容器节点：若有块级子元素则递归，否则当作叶子文本块
    if (hasBlockChild(el)) {
      for (let i = 0; i < el.children.length; i++) {
        walk(el.children[i]);
      }
    } else {
      addChunk('text', textOf(el));
    }
  }

  let extractError = null;
  try {
    walk(document.body);
  } catch (err) {
    extractError = (err && err.message) ? err.message : String(err);
  }

  // 动画自行淡出（与 promise 解析解耦，让摘取结果尽快返回）
  window.setTimeout(() => {
    root.dataset.leaving = 'true';
    window.setTimeout(() => {
      root.remove();
      style.remove();
    }, 620);
  }, 1700);

  // 摘取完成后立即 resolve，不必等动画播完
  return new Promise((resolve) => {
    window.setTimeout(() => {
      resolve({
        success: !extractError,
        chunks: extractError ? [] : chunks,
        error: extractError,
      });
    }, 900);
  });
})()
`;

async function runBrowserSummaryPreview(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    throw new Error('browser view is not available');
  }

  return webContents.executeJavaScript(SUMMARY_PREVIEW_SCRIPT, true);
}

module.exports = { runBrowserSummaryPreview };
