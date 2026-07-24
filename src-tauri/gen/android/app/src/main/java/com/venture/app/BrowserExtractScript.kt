package com.venture.app

/**
 * 提取网页核心文字内容的 JavaScript 脚本。
 * 与原版 Electron browser-summary-preview.cjs 等效，适配为 Android WebView evaluateJavascript() 同步返回模式。
 * 跳过脚本/图片/按钮等非文本节点，按语义分块（heading/text/code/quote/list），最大 600 块，每块 4000 字符。
 */
object BrowserExtractScript {
    val SCRIPT = """
(function() {
  var SKIP_TAGS = new Set([
    'SCRIPT','STYLE','NOSCRIPT','SVG','IMG','VIDEO','AUDIO','CANVAS',
    'IFRAME','BUTTON','INPUT','SELECT','TEXTAREA','OPTION','OPTGROUP',
    'TEMPLATE','OBJECT','EMBED','LINK','META','HEAD','MAP','AREA'
  ]);
  var BLOCK_TAGS = new Set([
    'P','H1','H2','H3','H4','H5','H6','PRE','BLOCKQUOTE','UL','OL','LI',
    'TABLE','THEAD','TBODY','TFOOT','TR','TD','TH','CAPTION','FIGCAPTION',
    'DL','DT','DD','DETAILS','SUMMARY','FIGURE','ADDRESS','ARTICLE',
    'SECTION','HEADER','FOOTER','ASIDE','NAV','MAIN','FORM','FIELDSET'
  ]);
  var MAX_CHUNKS = 600;
  var MAX_CHUNK_LEN = 4000;
  var chunks = [];
  var counter = 0;
  var seenText = new Set();

  function isRendered(el) {
    if (el.nodeType !== 1) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    var cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  function addChunk(type, content, level) {
    if (chunks.length >= MAX_CHUNKS) return;
    var text = String(content || '').replace(/[\t\r\n\f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    if (!text || text.length < 2) return;
    if (seenText.has(text)) return;
    seenText.add(text);
    var chunk = { id: 'chunk-' + (counter++), type: type, content: text.length > MAX_CHUNK_LEN ? text.slice(0, MAX_CHUNK_LEN) + '\u2026' : text };
    if (level !== undefined) chunk.level = level;
    chunks.push(chunk);
  }

  function textOf(el) {
    var t = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
    return t || '';
  }

  function hasBlockChild(el) {
    for (var i = 0; i < el.children.length; i++) {
      if (BLOCK_TAGS.has(el.children[i].tagName)) return true;
    }
    return false;
  }

  function walk(el) {
    if (el.nodeType !== 1) return;
    if (chunks.length >= MAX_CHUNKS) return;
    var tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (!isRendered(el)) return;
    var m = tag.match(/^H([1-6])$/);
    if (m) { addChunk('heading', textOf(el), parseInt(m[1], 10)); return; }
    if (tag === 'P' || tag === 'CAPTION' || tag === 'FIGCAPTION' || tag === 'SUMMARY' || tag === 'DD' || tag === 'DT' || tag === 'ADDRESS') { addChunk('text', textOf(el)); return; }
    if (tag === 'PRE') { addChunk('code', textOf(el)); return; }
    if (tag === 'BLOCKQUOTE') { addChunk('quote', textOf(el)); return; }
    if (tag === 'UL' || tag === 'OL') {
      var items = [];
      for (var i = 0; i < el.children.length; i++) {
        var li = el.children[i];
        if (li.tagName !== 'LI') continue;
        if (!isRendered(li)) continue;
        var t = textOf(li).replace(/\s+/g, ' ').trim();
        if (t) items.push(t);
      }
      if (items.length) addChunk('list', items.join('\n'));
      return;
    }
    if (tag === 'TD' || tag === 'TH') { addChunk('text', textOf(el)); return; }
    if (hasBlockChild(el)) {
      for (var i = 0; i < el.children.length; i++) walk(el.children[i]);
    } else {
      addChunk('text', textOf(el));
    }
  }

  var error = null;
  try { walk(document.body); } catch(e) { error = (e && e.message) ? e.message : String(e); }

  return JSON.stringify({
    success: !error,
    chunks: error ? [] : chunks,
    error: error || null
  });
})();
""".trimIndent()
}
