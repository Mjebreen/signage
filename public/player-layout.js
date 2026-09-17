/* Layout maths for the player, kept in its own plain-ES5 file so the same code
   runs on the TV and in the Node test-suite (test/orientation.test.js). */
(function (root) {
  'use strict';

  // A TV mounted on its side almost always keeps rendering a LANDSCAPE page, so
  // the player has to turn its own content. ROTATE_DEG is the turn applied when
  // the wanted orientation differs from the viewport's; "flip" adds 180 degrees
  // for a TV that was mounted the other way round.
  var ROTATE_DEG = 90;

  // viewW/viewH: what the browser reports. orientation: what a person looking at
  // the screen should see. Returns the logical box (in px) to lay content out in,
  // where to put it, how far to turn it, and "unit": 1% of its short side, which
  // every text size is derived from so type looks the same either way up.
  function decideLayout(viewW, viewH, orientation, flip, preview) {
    var wantPortrait = orientation === 'portrait';
    var w, h, deg;
    if (preview) {
      // Dashboard preview on a PC: upright and letterboxed, never turned.
      var ratio = wantPortrait ? 9 / 16 : 16 / 9;
      w = viewW; h = Math.round(viewW / ratio);
      if (h > viewH) { h = viewH; w = Math.round(viewH * ratio); }
      deg = 0;
    } else {
      var viewPortrait = viewH > viewW;
      var turn = wantPortrait !== viewPortrait;
      w = turn ? viewH : viewW;
      h = turn ? viewW : viewH;
      deg = ((turn ? ROTATE_DEG : 0) + (flip ? 180 : 0)) % 360;
    }
    return {
      width: w, height: h, deg: deg,
      // Centre the un-turned box; rotating about its centre then fills the view.
      left: Math.round((viewW - w) / 2), top: Math.round((viewH - h) / 2),
      unit: Math.min(w, h) / 100
    };
  }

  var api = { decideLayout: decideLayout, ROTATE_DEG: ROTATE_DEG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SignageLayout = api;
})(this);
