import { KeyboardEvent, PointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion, useIsoLayoutEffect } from './motion';
import {
  PAN_STEP,
  Rect,
  Size,
  ViewTransform,
  ZOOM_STEP,
  clampPan,
  fitRect,
  lerpTransform,
  isValidTransform,
  panBy,
  transformAttr,
  wheelFactor,
  zoomAt,
} from './zoom';

const DRAG_THRESHOLD = 4;
/** Camera flights (fit, zoom buttons, focus requests) ease over this many ms. */
export const CAMERA_MS = 420;
/**
 * Class of camera layers (layered scenes): elements laid out in world coordinates that get the
 * camera as a CSS transform. `translate3d` gives each layer its own compositor layer, so panning
 * only moves textures (no repaint / re-raster of the scene), and - unlike `will-change: transform` -
 * the browser still re-rasters at the new scale after a zoom, so the picture stays sharp.
 */
export const PZ_LAYER = 'pz-layer';

export function cssTransform(t: ViewTransform): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  return `translate3d(${r(t.x)}px, ${r(t.y)}px, 0) scale(${Math.round(t.k * 10000) / 10000})`;
}

/** Element size via ResizeObserver; ignores 0-size reports (element hidden with display: none). */
export function useElementSize<T extends HTMLElement>(): [React.RefObject<T>, Size] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 1200, height: 700 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const update = () =>
      setSize((prev) => {
        if (el.clientWidth === 0 || el.clientHeight === 0) return prev; // hidden: keep the last size
        const w = Math.max(320, Math.floor(el.clientWidth));
        const h = Math.max(200, Math.floor(el.clientHeight));
        return prev.width === w && prev.height === h ? prev : { width: w, height: h };
      });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export interface PanZoomOptions {
  content: Size;
  initial: ViewTransform | undefined;
  onChange: (t: ViewTransform) => void;
  /** Called (inside requestAnimationFrame) after a transform was written - e.g. level-of-detail classes. */
  onFrame?: (t: ViewTransform) => void;
  /** Max zoom for "fit" (default 1). */
  fitMaxK?: number;
}

export interface ApplyOptions {
  /** Ease to the target instead of jumping (skipped with reduced motion). */
  animate?: boolean;
}

/**
 * Ref-based zoom / pan for an SVG viewport: the transform lives in a ref and is written to the
 * viewport group (and every `.pz-layer` element inside the surface) via requestAnimationFrame, so
 * wheel / drag never re-render React. Programmatic moves can ease to their target.
 */
export function usePanZoom({ content, initial, onChange, onFrame, fitMaxK = 1 }: PanZoomOptions) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const gRef = useRef<SVGGElement>(null);
  const tRef = useRef<ViewTransform>(isValidTransform(initial) ? initial : { k: 1, x: 0, y: 0 });
  const initialized = useRef(isValidTransform(initial));
  /** Keep fitting on resize / content changes until the user moves the camera (or a camera was restored). */
  const autoFit = useRef(!isValidTransform(initial));
  const userMoved = useCallback(() => {
    autoFit.current = false;
  }, []);
  const raf = useRef<number | undefined>();
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>();
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const contentRef = useRef(content);
  contentRef.current = content;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const write = useCallback(() => {
    gRef.current?.setAttribute('transform', transformAttr(tRef.current));
    const layers = ref.current?.getElementsByClassName(PZ_LAYER);
    if (layers?.length) {
      // CSSOM write (not a style attribute): allowed by the webview's CSP
      const css = cssTransform(tRef.current);
      for (let i = 0; i < layers.length; i++) (layers[i] as HTMLElement | SVGElement).style.transform = css;
    }
    onFrameRef.current?.(tRef.current);
  }, [ref]);

  const persistSoon = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => onChangeRef.current(tRef.current), 300);
  }, []);

  /** Running camera flight (cancelled by any direct move). */
  const flight = useRef<number | undefined>();
  /** Where the running flight ends: repeated steps (zoom buttons, arrow keys) build on it. */
  const goal = useRef<ViewTransform | undefined>();
  const cancelFlight = useCallback(() => {
    if (flight.current !== undefined) cancelAnimationFrame(flight.current);
    flight.current = undefined;
    goal.current = undefined;
  }, []);
  /** The camera after the running flight (or the current one). */
  const aim = useCallback(() => goal.current ?? tRef.current, []);

  const apply = useCallback(
    (t: ViewTransform, opts?: ApplyOptions) => {
      const target = clampPan(t, contentRef.current, sizeRef.current);
      cancelFlight();
      const canAnimate = opts?.animate && typeof requestAnimationFrame === 'function' && typeof performance !== 'undefined' && !prefersReducedMotion();
      if (canAnimate) {
        const from = tRef.current;
        const start = performance.now();
        goal.current = target;
        const step = (now: number) => {
          const u = Math.min(1, (now - start) / CAMERA_MS);
          tRef.current = lerpTransform(from, target, u, sizeRef.current);
          write();
          flight.current = u < 1 ? requestAnimationFrame(step) : undefined;
          if (u >= 1) goal.current = undefined;
        };
        flight.current = requestAnimationFrame(step);
        // the target is what gets persisted, even if the flight is interrupted by an unmount
        if (persistTimer.current) clearTimeout(persistTimer.current);
        persistTimer.current = setTimeout(() => onChangeRef.current(flight.current === undefined ? tRef.current : target), CAMERA_MS + 300);
        return;
      }
      tRef.current = target;
      if (raf.current === undefined && typeof requestAnimationFrame === 'function') {
        raf.current = requestAnimationFrame(() => {
          raf.current = undefined;
          write();
        });
      }
      persistSoon();
    },
    [write, cancelFlight, persistSoon],
  );

  useEffect(
    () => () => {
      if (raf.current !== undefined) cancelAnimationFrame(raf.current);
      if (flight.current !== undefined) cancelAnimationFrame(flight.current);
      if (persistTimer.current) clearTimeout(persistTimer.current);
    },
    [],
  );

  const fitAll = useCallback(
    (opts?: ApplyOptions) => apply(fitRect({ x: 0, y: 0, ...contentRef.current }, sizeRef.current, 16, fitMaxK), opts),
    [apply, fitMaxK],
  );
  const zoomToRect = useCallback(
    (r: Rect, maxK: number) => {
      autoFit.current = false;
      apply(fitRect(r, sizeRef.current, 32, maxK), { animate: true });
    },
    [apply],
  );
  /** Centres a world point (keeping the zoom). */
  const centerOn = useCallback(
    (wx: number, wy: number, opts?: ApplyOptions) => {
      autoFit.current = false;
      const t = aim();
      apply({ k: t.k, x: sizeRef.current.width / 2 - wx * t.k, y: sizeRef.current.height / 2 - wy * t.k }, opts);
    },
    [apply, aim],
  );
  const zoomCenter = useCallback(
    (factor: number) => {
      autoFit.current = false;
      apply(zoomAt(aim(), factor, sizeRef.current.width / 2, sizeRef.current.height / 2), { animate: true });
    },
    [apply, aim],
  );
  /** Pans (keeping the zoom) so that a world rect is visible with some margin. */
  const ensureVisible = useCallback(
    (r: Rect, margin = 40) => {
      const t = aim();
      const s = sizeRef.current;
      const x0 = r.x * t.k + t.x;
      const y0 = r.y * t.k + t.y;
      const x1 = (r.x + r.width) * t.k + t.x;
      const y1 = (r.y + r.height) * t.k + t.y;
      let dx = 0;
      let dy = 0;
      if (x0 < margin) dx = margin - x0;
      else if (x1 > s.width - margin) dx = s.width - margin - x1;
      if (y0 < margin) dy = margin - y0;
      else if (y1 > s.height - margin) dy = s.height - margin - y1;
      if (dx || dy) apply(panBy(t, dx, dy), { animate: true });
    },
    [apply, aim],
  );

  // First content: fit (unless a persisted transform exists); otherwise just (re)write the transform.
  const hasContent = content.width > 0 && content.height > 0;
  useIsoLayoutEffect(() => {
    if ((!initialized.current || autoFit.current) && hasContent) {
      initialized.current = true;
      fitAll();
    } else {
      write();
    }
  }, [content.width, content.height, size, fitAll, write, hasContent]);

  // Wheel zoom (non-passive so the webview does not scroll).
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userMoved();
      const rect = el.getBoundingClientRect();
      apply(zoomAt(tRef.current, wheelFactor(e.deltaY, e.deltaMode), e.clientX - rect.left, e.clientY - rect.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [apply, ref, userMoved]);

  // Drag to pan; pointer capture only after a small threshold so clicks keep working.
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | undefined>();
  const suppressClick = useRef(false);
  const handlers = {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    },
    onPointerMove: (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.moved = true;
        userMoved();
        ref.current?.setPointerCapture?.(e.pointerId);
        ref.current?.classList.add('is-panning');
      }
      d.x = e.clientX;
      d.y = e.clientY;
      apply(panBy(tRef.current, dx, dy));
    },
    onPointerUp: (e: PointerEvent) => endDrag(e),
    onPointerCancel: (e: PointerEvent) => endDrag(e),
    onClickCapture: (e: React.MouseEvent) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    /** Keys when the surface itself is focused: +/- zoom, 0 fit, arrows pan. */
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== ref.current) return;
      switch (e.key) {
        case '+':
        case '=':
          zoomCenter(ZOOM_STEP);
          break;
        case '-':
        case '_':
          zoomCenter(1 / ZOOM_STEP);
          break;
        case '0':
          fitAll({ animate: true });
          break;
        case 'ArrowLeft':
          apply(panBy(aim(), PAN_STEP, 0), { animate: true });
          break;
        case 'ArrowRight':
          apply(panBy(aim(), -PAN_STEP, 0), { animate: true });
          break;
        case 'ArrowUp':
          apply(panBy(aim(), 0, PAN_STEP), { animate: true });
          break;
        case 'ArrowDown':
          apply(panBy(aim(), 0, -PAN_STEP), { animate: true });
          break;
        default:
          return;
      }
      if (e.key !== '0') userMoved();
      e.preventDefault();
    },
  };
  function endDrag(e: PointerEvent) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (d.moved) {
      suppressClick.current = true;
      ref.current?.releasePointerCapture?.(e.pointerId);
      ref.current?.classList.remove('is-panning');
    }
    drag.current = undefined;
  }

  return { ref, gRef, size, tRef, apply, fitAll, zoomToRect, zoomCenter, centerOn, ensureVisible, handlers };
}
