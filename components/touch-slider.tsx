"use client";

/**
 * A slider that works with a finger on a tablet, used instead of <input type="range">.
 *
 * On iPad Safari the native range input only moves when its small thumb is grabbed, ignores taps on the track, and
 * gives up the drag when a slight vertical move turns it into a page scroll. This one is 44 px tall with a 28 px
 * thumb; `touch-action: pan-y` leaves vertical moves to the page. A touch that starts moving sideways drags the
 * value (wherever on the track it started); a touch that starts moving vertically is a scroll and changes nothing;
 * a tap without movement sets the value at the tap. A mouse drags at once. Arrow keys, Home and End work too.
 */

import { useRef } from "react";
import { snapToStep } from "@/lib/client/slider-step";

const DRAG_START_PX = 6;

export function TouchSlider({
  value,
  min,
  max,
  step,
  disabled = false,
  label,
  accent = "#22d3ee",
  onChange,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  /** Accessible name (the visible label sits next to the slider). */
  label: string;
  accent?: string;
  /** Every change while dragging. */
  onChange: (v: number) => void;
  /** When the finger or mouse is released (or a key changed the value). */
  onCommit?: (v: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<{ id: number; x0: number; y0: number; dragging: boolean; last: number } | null>(null);

  const snap = (v: number) => snapToStep(v, min, max, step);
  const valueAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return snap(min + ((clientX - r.left) / r.width) * (max - min));
  };
  const set = (v: number) => {
    if (gesture.current) gesture.current.last = v;
    if (v !== value) onChange(v);
  };

  const pct = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-disabled={disabled}
      className={`relative h-11 w-full select-none outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 rounded-lg ${disabled ? "opacity-40" : "cursor-pointer"}`}
      style={{ touchAction: "pan-y", WebkitTapHighlightColor: "transparent" }}
      onPointerDown={(e) => {
        if (disabled || (e.pointerType === "mouse" && e.button !== 0)) return;
        const mouse = e.pointerType === "mouse";
        gesture.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dragging: mouse, last: value };
        if (mouse) {
          e.currentTarget.setPointerCapture(e.pointerId);
          set(valueAt(e.clientX));
        }
      }}
      onPointerMove={(e) => {
        const g = gesture.current;
        if (!g || g.id !== e.pointerId || disabled) return;
        if (!g.dragging) {
          const dx = Math.abs(e.clientX - g.x0);
          const dy = Math.abs(e.clientY - g.y0);
          if (dx < DRAG_START_PX && dy < DRAG_START_PX) return;
          if (dy >= dx) {
            gesture.current = null; // a scroll: the browser takes it (pointercancel follows)
            return;
          }
          g.dragging = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        set(valueAt(e.clientX));
      }}
      onPointerUp={(e) => {
        const g = gesture.current;
        if (!g || g.id !== e.pointerId) return;
        gesture.current = null;
        if (disabled) return;
        const v = g.dragging ? g.last : valueAt(e.clientX); // a tap sets the value where it landed
        if (v !== value) onChange(v);
        onCommit?.(v);
      }}
      onPointerCancel={() => {
        gesture.current = null;
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step } as Record<string, number>;
        let v: number | null = null;
        if (e.key in delta) v = snap(value + delta[e.key]);
        else if (e.key === "Home") v = min;
        else if (e.key === "End") v = max;
        if (v === null) return;
        e.preventDefault();
        if (v !== value) onChange(v);
        onCommit?.(v);
      }}
    >
      <div ref={trackRef} className="absolute inset-x-3.5 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-slate-700">
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: accent }} />
        <div
          className="absolute top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white shadow"
          style={{ left: `${pct}%`, borderColor: accent }}
        />
      </div>
    </div>
  );
}
