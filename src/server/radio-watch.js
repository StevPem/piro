'use strict';

/**
 * Optional: give up on a radio that has stopped answering CI-V. After it
 * has not answered (CivDriver 'answering' false) for `minutes`, calls
 * `giveUp()`, which index.js uses to exit so systemd starts PiRO afresh and
 * reopens the serial port. That can clear a wedged USB serial link. It
 * can't clear a radio whose own CI-V has hung (only a power cycle does),
 * and with the radio switched off PiRO would restart every `minutes`, so
 * it is off unless CIV_SILENT_RESTART_MINUTES is set.
 *
 * Returns stop(), which removes the listener and any timer.
 */
function watchRadio({ civ, minutes, giveUp, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!minutes || minutes <= 0) return () => {};
  let timer = null;
  const onAnswering = (answering) => {
    if (answering) {
      if (timer) clearTimer(timer);
      timer = null;
    } else if (!timer) {
      timer = setTimer(() => {
        timer = null;
        giveUp();
      }, minutes * 60000);
      timer.unref?.();
    }
  };
  civ.on('answering', onAnswering);
  return () => {
    civ.off('answering', onAnswering);
    if (timer) clearTimer(timer);
    timer = null;
  };
}

module.exports = { watchRadio };
