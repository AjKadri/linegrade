import { useEffect, useRef, useState } from 'react';

const query = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia(query).matches;
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion());
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

// Counts from 0 to target. With reduced motion it returns the target immediately.
export function useCountUp(target, { duration = 1200, enabled = true } = {}) {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(reduced || !enabled ? target : 0);
  const raf = useRef();
  useEffect(() => {
    if (reduced || !enabled) { setValue(target); return undefined; }
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      setValue(Math.round(target * (1 - (1 - p) ** 3)));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration, enabled, reduced]);
  return value;
}
