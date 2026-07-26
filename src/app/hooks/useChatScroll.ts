import { useEffect, useRef, useCallback, useState } from "react";

const NEAR_BOTTOM_THRESHOLD = 50;

export function useChatScroll() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const isAutoScrollEnabledRef = useRef(true);
  const rafIdRef = useRef<number | null>(null);

  const scrollContainerRef = useCallback((node: HTMLDivElement | null) => {
    setContainer(node);
  }, []);

  const forceScrollToBottom = useCallback(() => {
    isAutoScrollEnabledRef.current = true;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
  }, [container]);

  useEffect(() => {
    if (!container) return;

    const updateAutoScrollState = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      isAutoScrollEnabledRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD;
    };

    const doScroll = () => {
      if (isAutoScrollEnabledRef.current) {
        container.scrollTop = container.scrollHeight - container.clientHeight;
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        isAutoScrollEnabledRef.current = false;
      } else {
        const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (dist <= NEAR_BOTTOM_THRESHOLD) {
          isAutoScrollEnabledRef.current = true;
        }
      }
    };

    const handleTouchStart = () => {
      isAutoScrollEnabledRef.current = false;
    };

    const handleTouchEnd = () => {
      setTimeout(() => {
        updateAutoScrollState();
      }, 100);
    };

    const handleScroll = () => {
      updateAutoScrollState();
    };

    // MutationObserver covers DOM content changes (new message blocks streaming in)
    const mutationObserver = new MutationObserver(() => {
      if (!isAutoScrollEnabledRef.current) return;
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        doScroll();
      });
    });
    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // ResizeObserver covers height changes (input area resize, images loading)
    const resizeObserver = new ResizeObserver(() => {
      if (!isAutoScrollEnabledRef.current) return;
      doScroll();
    });
    resizeObserver.observe(container);

    const handleWindowResize = () => {
      if (isAutoScrollEnabledRef.current) doScroll();
    };
    window.addEventListener("resize", handleWindowResize);

    container.addEventListener("scroll", handleScroll, { passive: true });
    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });

    doScroll();

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchend", handleTouchEnd);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [container]);

  return {
    scrollContainerRef,
    forceScrollToBottom,
    isAutoScrollEnabledRef,
  };
}
