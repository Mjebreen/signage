/* Layout maths for the player, kept in its own plain-ES5 file so the same code
   runs on the TV and in the Node test-suite (test/orientation.test.js). */
(function (root) {
  'use strict';

  // A TV mounted on its side almost always keeps rendering a LANDSCAPE page, so
  // the player has to turn its own content. Samsung's manuals say to hang a panel
  // in portrait by turning it CLOCKWISE, which leaves the picture needing a
  // counter-clockwise turn: 270 degrees. "flip" adds 180 for a TV that was hung
  // the other way round.
  var ROTATE_DEG = 270;

  // Exact integer matrices about the top-left corner. Rotating about the centre
  // would shift the box by (w - h) / 2, a half pixel whenever that is odd, which
  // blurs the whole page; rotate(90deg) also leaves a 6e-17 where a 0 belongs.
  function matrixFor(deg, viewW, viewH) {
    if (deg === 90) return 'matrix(0,1,-1,0,' + viewW + ',0)';
    if (deg === 270) return 'matrix(0,-1,1,0,0,' + viewH + ')';
    if (deg === 180) return 'matrix(-1,0,0,-1,' + viewW + ',' + viewH + ')';
    return 'none';
  }

  // viewW/viewH: what the browser reports (never assume 1920x1080; TV browsers
  // also report 1280x720 and 960x540). orientation: what a person looking at the
  // screen should see. Returns the logical box (px) to lay content out in, where
  // to put it, the transform that makes it fill the view, and "unit": 1% of its
  // short side, which every text size is derived from.
  function decideLayout(viewW, viewH, orientation, flip, preview) {
    var wantPortrait = orientation === 'portrait';
    var w, h, deg, left = 0, top = 0;
    if (preview) {
      // Dashboard preview on a PC: upright and letterboxed, never turned.
      var ratio = wantPortrait ? 9 / 16 : 16 / 9;
      w = viewW; h = Math.round(viewW / ratio);
      if (h > viewH) { h = viewH; w = Math.round(viewH * ratio); }
      deg = 0;
      left = Math.round((viewW - w) / 2); top = Math.round((viewH - h) / 2);
    } else {
      var viewPortrait = viewH > viewW;
      var turn = wantPortrait !== viewPortrait;
      w = turn ? viewH : viewW;
      h = turn ? viewW : viewH;
      deg = ((turn ? ROTATE_DEG : 0) + (flip ? 180 : 0)) % 360;
    }
    return {
      width: w, height: h, deg: deg, left: left, top: top,
      transform: matrixFor(deg, viewW, viewH),
      unit: Math.min(w, h) / 100
    };
  }

  var api = { decideLayout: decideLayout, matrixFor: matrixFor, ROTATE_DEG: ROTATE_DEG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SignageLayout = api;
})(this);
