import React, { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";

const words = ["Code", "Agent", "Design", "Build", "Think"];

export function TypewriterHeading() {
  const [text, setText] = useState("");
  const [wordIndex, setWordIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSmall, setIsSmall] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Hide the typing text when container is very narrow
        setIsSmall(entry.contentRect.width < 450);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const currentWord = words[wordIndex];
    // Slightly randomize typing speed for realism
    const typingSpeed = 80 + Math.random() * 40;
    const deletingSpeed = 50;
    const pauseTime = 2000;

    let timeout: NodeJS.Timeout;

    if (!isDeleting) {
      if (text.length < currentWord.length) {
        timeout = setTimeout(() => {
          setText(currentWord.substring(0, text.length + 1));
        }, typingSpeed);
      } else {
        timeout = setTimeout(() => {
          setIsDeleting(true);
        }, pauseTime);
      }
    } else {
      if (text.length > 0) {
        timeout = setTimeout(() => {
          setText(currentWord.substring(0, text.length - 1));
        }, deletingSpeed);
      } else {
        setIsDeleting(false);
        setWordIndex((prev) => (prev + 1) % words.length);
      }
    }

    return () => clearTimeout(timeout);
  }, [text, isDeleting, wordIndex]);

  return (
    <div ref={containerRef} className="w-full flex justify-center select-none">
      <h2 className="text-4xl sm:text-6xl font-light tracking-[-0.04em] text-foreground mb-6 flex items-center justify-center">
        Venture{!isSmall && <>&nbsp;</>}
        {!isSmall && (
          <>
            <span className="font-serif italic text-muted-foreground">
              {text}
            </span>
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                repeat: Infinity,
                duration: 0.8,
                repeatType: "reverse",
                ease: "easeInOut",
              }}
              className="inline-block w-[2px] h-[0.9em] bg-muted-foreground/80 ml-1"
            />
          </>
        )}
      </h2>
    </div>
  );
}
