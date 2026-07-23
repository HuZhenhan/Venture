let listenerInstalled = false;

function handleMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const tagName = target.tagName.toLowerCase();
  const className = target.className || '';
  const id = target.id || '';
  const ariaLabel = target.getAttribute('aria-label') || '';
  const dataset = target.dataset || {};
  const webkitAppRegion = getComputedStyle(target).webkitAppRegion;

  console.log(
    `%c[ClickLog] %cclick @ (${Math.round(e.clientX)}, ${Math.round(e.clientY)}) %c${tagName}%c${id ? `#${id}` : ''}${ariaLabel ? ` [${ariaLabel}]` : ''}`,
    'color: #f0a; font-weight: bold',
    'color: #888',
    'color: #0af; font-weight: bold',
    'color: #888',
    {
      className: className.slice(0, 80),
      webkitAppRegion,
      dataset: Object.keys(dataset).length > 0 ? dataset : undefined,
      path: e.composedPath().slice(0, 5).map((el: EventTarget) => {
        if (!(el instanceof HTMLElement)) return null;
        const tag = el.tagName.toLowerCase();
        const cls = el.className?.toString().slice(0, 40) || '';
        const region = getComputedStyle(el).webkitAppRegion;
        return `${tag}${cls ? `.${cls.replace(/\s+/g, '.')}` : ''} [region:${region}]`;
      }).filter(Boolean),
    }
  );
}

export function startClickLogging() {
  if (listenerInstalled) return;
  listenerInstalled = true;
  document.addEventListener('mousedown', handleMouseDown, true);
  console.log('%c[ClickLog] 点击事件日志已开启', 'color: #0f0; font-weight: bold');
}

export function stopClickLogging() {
  if (!listenerInstalled) return;
  listenerInstalled = false;
  document.removeEventListener('mousedown', handleMouseDown, true);
  console.log('%c[ClickLog] 点击事件日志已关闭', 'color: #f90; font-weight: bold');
}