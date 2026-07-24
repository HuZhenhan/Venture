import React, { useState, useEffect, useRef, memo, createContext, useContext } from "react";
import { motion } from "motion/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
  status?: "typing" | "done" | "loading" | "reasoning";
  onComplete?: () => void;
  className?: string;
}

const TypingCtx = createContext(false);
const TextLenCtx = createContext(0);

const TypingCursor = memo(function TypingCursor() {
  return (
    <motion.span
      animate={{ opacity: [1, 0, 1] }}
      transition={{ duration: 0.6, repeat: Infinity, ease: "linear" }}
      className="inline-block w-[2px] h-[1em] bg-foreground ml-[2px] align-[-0.15em]"
    />
  );
});

const MdH1 = ({ node, children, ...props }: any) => {
  const isTyping = useContext(TypingCtx);
  const textLen = useContext(TextLenCtx);
  const isLast = (node?.position?.end?.offset ?? 0) >= textLen;
  return (
    <h1 className="text-xl font-bold text-foreground mt-6 mb-2" {...props}>
      {children}
      {isTyping && isLast && <TypingCursor />}
    </h1>
  );
};

const MdH2 = ({ node, children, ...props }: any) => {
  const isTyping = useContext(TypingCtx);
  const textLen = useContext(TextLenCtx);
  const isLast = (node?.position?.end?.offset ?? 0) >= textLen;
  return (
    <h2 className="text-lg font-bold text-foreground mt-5 mb-2" {...props}>
      {children}
      {isTyping && isLast && <TypingCursor />}
    </h2>
  );
};

const MdH3 = ({ node, children, ...props }: any) => {
  const isTyping = useContext(TypingCtx);
  const textLen = useContext(TextLenCtx);
  const isLast = (node?.position?.end?.offset ?? 0) >= textLen;
  return (
    <h3 className="text-md font-bold text-foreground mt-4 mb-1" {...props}>
      {children}
      {isTyping && isLast && <TypingCursor />}
    </h3>
  );
};

const MdUl = ({ node: _node, ...props }: any) => (
  <ul className="list-disc pl-5 mb-3 space-y-1" {...props} />
);
const MdOl = ({ node: _node, ...props }: any) => (
  <ol className="list-decimal pl-5 mb-3 space-y-1" {...props} />
);

const MdLi = ({ node, children, ...props }: any) => {
  const isTyping = useContext(TypingCtx);
  const textLen = useContext(TextLenCtx);
  const isLast = (node?.position?.end?.offset ?? 0) >= textLen;
  return (
    <li className="pl-1" {...props}>
      {children}
      {isTyping && isLast && <TypingCursor />}
    </li>
  );
};

const MdBlockquote = ({ node: _node, ...props }: any) => (
  <blockquote
    className="border-l-2 border-border pl-4 italic text-muted-foreground my-4"
    {...props}
  />
);
const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function sanitizeHref(href: unknown): string | undefined {
  if (typeof href !== 'string' || href.length === 0) return undefined;
  const trimmed = href.trim();
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return trimmed;
  try {
    const parsed = new URL(trimmed, 'http://_local');
    if (!ALLOWED_LINK_PROTOCOLS.has(parsed.protocol)) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

const MdA = ({ node: _node, href, children, ...props }: any) => {
  const safeHref = sanitizeHref(href);
  if (!safeHref) {
    return <span className="text-muted-foreground line-through">{children}</span>;
  }
  return (
    <a
      className="text-primary hover:underline"
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  );
};
const MdCode = ({ node: _node, className, children, ...props }: any) => {
  const match = /language-(\w+)/.exec(className || "");
  const isInline = !match && !className;
  if (isInline) {
    return (
      <code
        className="bg-muted px-1.5 py-0.5 rounded text-foreground font-mono text-[0.9em]"
        {...props}
      >
        {children}
      </code>
    );
  }
  return (
    <pre className="bg-muted/50 p-4 rounded-xl my-4 overflow-x-auto border border-border">
      <code className="text-[13px] font-mono text-foreground" {...props}>
        {children}
      </code>
    </pre>
  );
};

const MdP = ({ node, children, ...props }: any) => {
  const isTyping = useContext(TypingCtx);
  const textLen = useContext(TextLenCtx);
  const isLast = (node?.position?.end?.offset ?? 0) >= textLen;
  return (
    <div className="mb-3 last:mb-0" {...props}>
      {children}
      {isTyping && isLast && <TypingCursor />}
    </div>
  );
};

const MD_COMPONENTS = {
  h1: MdH1,
  h2: MdH2,
  h3: MdH3,
  p: MdP,
  ul: MdUl,
  ol: MdOl,
  li: MdLi,
  code: MdCode,
  blockquote: MdBlockquote,
  a: MdA,
};

const REMARK_PLUGINS = [remarkGfm];

export const MarkdownContent = memo(function MarkdownContent({
  content,
  status,
  onComplete,
  className = "",
}: MarkdownContentProps) {
  const [displayedText, setDisplayedText] = useState(
    status === "done" ? content : ""
  );

  const contentBufferRef = useRef(content);
  contentBufferRef.current = content;

  const posRef = useRef(status === "done" ? content.length : 0);

  const statusRef = useRef(status);
  statusRef.current = status;

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (status === "done") {
      posRef.current = content.length;
      setDisplayedText(content);
    }
  }, [status, content]);

  useEffect(() => {
    if (status !== "typing") return;

    posRef.current = 0;
    setDisplayedText("");

    let rafId = 0;
    let idleTimer: number | null = null;
    let active = true;

    const scheduleNext = (viaIdle: boolean) => {
      if (!active) return;
      if (viaIdle) {
        idleTimer = window.setTimeout(() => {
          idleTimer = null;
          rafId = requestAnimationFrame(tick);
        }, 33);
      } else {
        rafId = requestAnimationFrame(tick);
      }
    };

    const tick = () => {
      if (!active) return;

      const buffer = contentBufferRef.current;
      const pos = posRef.current;

      if (pos < buffer.length) {
        const remaining = buffer.length - pos;
        let charsToAdd = 4;
        if (remaining > 500) {
          charsToAdd = Math.max(8, Math.ceil(remaining / 30));
        } else if (remaining > 200) {
          charsToAdd = Math.max(6, Math.ceil(remaining / 40));
        }

        const next = Math.min(pos + charsToAdd, buffer.length);
        posRef.current = next;
        setDisplayedText(buffer.slice(0, next));
        scheduleNext(false);
        return;
      }

      if (statusRef.current === "typing") {
        // Idle: buffer caught up. Poll less frequently to save CPU.
        scheduleNext(true);
      } else {
        onCompleteRef.current?.();
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      active = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (idleTimer !== null) window.clearTimeout(idleTimer);
    };
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const isTyping = status === "typing";
  const textLen = displayedText.length;

  return (
    <TypingCtx.Provider value={isTyping}>
      <TextLenCtx.Provider value={textLen}>
        <div
          className={`markdown-content text-[16px] leading-[1.7] tracking-tight text-foreground font-normal ${className}`}
        >
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MD_COMPONENTS}>
            {displayedText}
          </ReactMarkdown>
        </div>
      </TextLenCtx.Provider>
    </TypingCtx.Provider>
  );
});
