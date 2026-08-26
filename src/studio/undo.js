/*
 * Undo badge. Delete (and later, other reversible acts) offer Undo
 * here instead of dropping the record. One badge at a time.
 */
'use strict';

const HIDE_MS = 8000;
const LEAVE_MS = 180;


function clearTimers(session) {
    const ui = session && session.ui;
    if (!ui) return;
    if (ui.undoHide) {
        clearTimeout(ui.undoHide);
        ui.undoHide = 0;
    }
    if (ui.undoGone) {
        clearTimeout(ui.undoGone);
        ui.undoGone = 0;
    }
}


function paint(session) {
    if (session && typeof session.redraw === 'function') session.redraw();
}


function offerUndo(session, input) {
    if (!session || !session.ui) return;
    const message = input && typeof input.message === 'string' ? input.message : '';
    const run = input && typeof input.run === 'function' ? input.run : null;
    if (!message || !run) return;
    clearTimers(session);
    session.ui.undo = {
        id: Date.now(),
        message,
        run,
        leaving: false,
    };
    session.ui.undoHide = setTimeout(() => dismissUndo(session), HIDE_MS);
    paint(session);
}


function hasUndo(session) {
    const undo = session && session.ui && session.ui.undo;
    return !!(undo && !undo.leaving && undo.run);
}


function dismissUndo(session, opts) {
    const ui = session && session.ui;
    if (!ui || !ui.undo) return;
    const item = ui.undo;
    clearTimers(session);
    if (opts && opts.immediate) {
        ui.undo = null;
        paint(session);
        return;
    }
    item.leaving = true;
    paint(session);
    ui.undoGone = setTimeout(() => {
        if (ui.undo && ui.undo.id === item.id) ui.undo = null;
        paint(session);
    }, LEAVE_MS);
}


function runUndo(session) {
    const undo = session && session.ui && session.ui.undo;
    if (!undo || undo.leaving || typeof undo.run !== 'function') return;
    const run = undo.run;
    dismissUndo(session, {immediate: true});
    run();
}


module.exports = {
    HIDE_MS,
    offerUndo,
    hasUndo,
    dismissUndo,
    runUndo,
};
