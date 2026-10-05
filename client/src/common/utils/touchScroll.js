import { barKeySequence } from "@/common/utils/keyBarSequences.js";

const SLOP = 10;
const MIN_FLING_VELOCITY = 0.3;
const STOP_VELOCITY = 0.05;
const FRICTION = 0.95;

// An application in the alternate screen has no scrollback on our side, so a swipe must reach
// it as input: as wheel reports when it asked for mouse events, as page keys otherwise. xterm's
// own wheel fallback there would send arrow keys, which move through a prompt's history.
export const touchScrollMode = ({ mouseTracking, alternateBuffer }) => {
    if (mouseTracking) return "wheel";
    if (alternateBuffer) return "page";
    return "local";
};

export const takeSteps = (distance, unit) => {
    const steps = Math.trunc(distance / unit);
    return { steps, rest: distance - steps * unit };
};

export const attachTouchScroll = (term, element) => {
    let gesture = null;
    let fling = null;

    const cellHeight = () => term._core?._renderService?.dimensions?.css?.cell?.height
        || element.clientHeight / (term.rows || 1);

    const currentMode = () => touchScrollMode({
        mouseTracking: term.modes.mouseTrackingMode !== "none",
        alternateBuffer: term.buffer.active.type === "alternate",
    });

    const unitFor = (mode) => (mode === "page" ? element.clientHeight / 2 : cellHeight());

    // Positive steps scroll towards newer content, i.e. the finger moved up.
    const emit = (state, steps) => {
        if (state.mode === "local") {
            term.scrollLines(steps);
        } else if (state.mode === "page") {
            const sequence = barKeySequence(steps < 0 ? "pageup" : "pagedown");
            for (let i = 0; i < Math.abs(steps); i++) term.input(sequence, true);
        } else {
            const deltaY = Math.sign(steps) * cellHeight();
            for (let i = 0; i < Math.abs(steps); i++) {
                state.target.dispatchEvent(new WheelEvent("wheel", {
                    deltaY, deltaMode: 0, clientX: state.x, clientY: state.y, bubbles: true, cancelable: true,
                }));
            }
        }
    };

    const advance = (state, delta) => {
        const { steps, rest } = takeSteps(state.pending + delta, unitFor(state.mode));
        state.pending = rest;
        if (steps) emit(state, steps);
    };

    const stopFling = () => {
        if (fling) cancelAnimationFrame(fling.frame);
        fling = null;
    };

    const onTouchStart = (event) => {
        stopFling();
        if (event.touches.length !== 1) {
            gesture = null;
            return;
        }
        const touch = event.touches[0];
        gesture = {
            startX: touch.clientX, startY: touch.clientY, lastY: touch.clientY, lastTime: event.timeStamp,
            x: touch.clientX, y: touch.clientY, target: event.target,
            active: false, pending: 0, velocity: 0, mode: currentMode(),
        };
    };

    const onTouchMove = (event) => {
        if (!gesture || event.touches.length !== 1) return;
        const touch = event.touches[0];

        if (!gesture.active) {
            const dx = Math.abs(touch.clientX - gesture.startX);
            const dy = Math.abs(touch.clientY - gesture.startY);
            if (dy < SLOP || dx > dy) {
                if (dx > SLOP) gesture = null;
                return;
            }
            gesture.active = true;
            gesture.lastY = touch.clientY;
        }

        event.preventDefault();
        event.stopPropagation();

        const delta = gesture.lastY - touch.clientY;
        const elapsed = event.timeStamp - gesture.lastTime;
        if (elapsed > 0) gesture.velocity = delta / elapsed;
        gesture.lastY = touch.clientY;
        gesture.lastTime = event.timeStamp;
        advance(gesture, delta);
    };

    const onTouchEnd = () => {
        const ended = gesture;
        gesture = null;
        if (!ended?.active || ended.mode === "page" || Math.abs(ended.velocity) < MIN_FLING_VELOCITY) return;

        fling = { state: ended, velocity: ended.velocity, last: performance.now(), frame: 0 };
        const step = (now) => {
            if (!fling) return;
            const elapsed = now - fling.last;
            fling.last = now;
            advance(fling.state, fling.velocity * elapsed);
            fling.velocity *= FRICTION;
            if (Math.abs(fling.velocity) < STOP_VELOCITY) fling = null;
            else fling.frame = requestAnimationFrame(step);
        };
        fling.frame = requestAnimationFrame(step);
    };

    element.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    element.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    element.addEventListener("touchend", onTouchEnd, { capture: true });
    element.addEventListener("touchcancel", onTouchEnd, { capture: true });

    return () => {
        stopFling();
        element.removeEventListener("touchstart", onTouchStart, { capture: true });
        element.removeEventListener("touchmove", onTouchMove, { capture: true });
        element.removeEventListener("touchend", onTouchEnd, { capture: true });
        element.removeEventListener("touchcancel", onTouchEnd, { capture: true });
    };
};
