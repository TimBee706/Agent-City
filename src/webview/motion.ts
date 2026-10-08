import { useEffect, useLayoutEffect, useState } from 'react';

/** useLayoutEffect in the browser, useEffect during server rendering (unit tests) - no SSR warning. */
export const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** True if the OS (prefers-reduced-motion) or VS Code (body.vscode-reduce-motion) asks for less motion. */
export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.body?.classList.contains('vscode-reduce-motion')) return true;
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const update = () => setReduced(prefersReducedMotion());
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    mq?.addEventListener?.('change', update);
    // VS Code toggles body classes when the setting / theme changes.
    const mo = new MutationObserver(update);
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      mq?.removeEventListener?.('change', update);
      mo.disconnect();
    };
  }, []);
  return reduced;
}
