// Drag-to-scrub for number inputs — the Blender/Figma gesture. Drag left or
// right anywhere on a field to change it; a plain click still focuses it for
// typing, and the native spinner arrows keep working.

const PX_PER_STEP_INT = 4;   // counts move slower — their ranges are small
const PX_PER_STEP_FRAC = 2;
const DRAG_THRESHOLD = 3;    // px of travel before a click becomes a drag
const SPINNER_ZONE = 20;     // right edge left to the native up/down arrows

// step="any" fields get an increment scaled to what they currently hold, so a
// 355.6 mm diameter moves in whole mm while a 0.15 mm clearance moves in
// thousandths. Fields sitting at 0 have no magnitude to read, so they get a
// middling default. Whole-number fields (counts, seeds) are the ones that want
// the slower travel — their ranges are only a dozen or so wide.
function scaleFor(input) {
  const attr = parseFloat(input.step);
  if (Number.isFinite(attr) && attr > 0) {
    return { step: attr, pxPerStep: Number.isInteger(attr) ? PX_PER_STEP_INT : PX_PER_STEP_FRAC };
  }
  const v = Math.abs(parseFloat(input.value)) || 0;
  const step = v ? Math.min(1, Math.max(0.001, 10 ** (Math.floor(Math.log10(v)) - 2))) : 0.1;
  return { step, pxPerStep: PX_PER_STEP_FRAC };
}

const decimalsFor = (step) => Math.min(6, Math.max(0, -Math.floor(Math.log10(step))));

function commit(input, value, step) {
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  let v = value;
  if (Number.isFinite(min)) v = Math.max(min, v);
  if (Number.isFinite(max)) v = Math.min(max, v);
  const next = String(Number(v.toFixed(decimalsFor(step))));
  if (next === input.value) return;
  input.value = next;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function attach(input) {
  if (!input.title) input.title = 'Drag left/right to adjust — shift ×10, alt fine';

  input.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || input.disabled) return;
    if (input.clientWidth > 2 * SPINNER_ZONE &&
        e.offsetX > input.clientWidth - SPINNER_ZONE) return;  // native arrows
    if (document.activeElement === input) return;              // mid-edit: let the caret land

    const startX = e.clientX;
    const startText = input.value;
    const startVal = parseFloat(startText) || 0;
    const { step, pxPerStep } = scaleFor(input);
    let dragging = false;

    // Capture keeps the drag alive if the pointer is released off-window; the
    // listeners hang off window either way, since captured events still bubble.
    try { input.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
    e.preventDefault();  // no focus or text selection yet — a click restores it below

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        dragging = true;
        document.body.classList.add('scrubbing');
      }
      const scaled = step * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
      commit(input, startVal + Math.round(dx / pxPerStep) * scaled, scaled);
    };

    // Escape puts back the text we started with, not a re-rounded version of it.
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      if (input.value !== startText) {
        input.value = startText;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      finish();
    };

    const onUp = () => {
      const wasDrag = dragging;
      finish();
      if (!wasDrag) { input.focus(); input.select(); }
    };

    function finish() {
      try { input.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('scrubbing');
      dragging = false;
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey);
  });
}

export function enableScrub(inputs) {
  inputs.forEach(attach);
}
