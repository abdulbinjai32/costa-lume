// Costa Lume — the start and pause screens. Pure DOM: bind the ids index.html already ships, swap
// the `hidden` class on the screens, and hand every real decision back to main.js through callbacks.
//
// Esc is routed by main.js (it owns the pointer lock), so it calls showPause()/hidePause(); nothing
// in here listens for keys and no code in here starts or stops the game by itself.

const START_STORY =
  'Rafa Duarte spends his days keeping boat engines alive in Costa Lume, until Mira Solano offers ' +
  'him work that pays off what he owes.';

const CONTROLS = [
  ['W A S D', 'Walk · drive'],
  ['Shift', 'Sprint'],
  ['Space', 'Jump · handbrake'],
  ['F', 'Enter / leave a car'],
  ['Left mouse', 'Fire'],
  ['Right mouse', 'Aim'],
  ['1 2 3', 'Fists · pistol · SMG'],
  ['R', 'Reload'],
  ['H', 'Horn'],
  ['T', 'Next radio station'],
  ['C', 'Camera while driving'],
  ['M', 'Mute sound'],
  ['Tab', 'Map'],
  ['Esc', 'Pause · saves'],
  ['Enter', 'Retry a failed job'],
];

const byId = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

export function createMenus({
  onNew, onResume, onQuit, onStart, onContinue, onSave, onRetry,
} = {}) {
  const el = {
    start: byId('start'),
    pause: byId('pause'),
    btnNew: byId('btn-new'),
    btnControls: byId('btn-controls'),
    btnResume: byId('btn-resume'),
    btnControls2: byId('btn-controls2'),
    btnMenu: byId('btn-menu'),
    btnContinue: byId('btn-continue'),
    btnSave: byId('btn-save'),
    btnRetry: byId('btn-retry'),
    controls: byId('controls'),
    controls2: byId('controls2'),
    story: byId('story'),
  };

  const fire = (fn, arg) => {
    if (typeof fn === 'function') fn(arg);
  };

  const setHidden = (node, hidden) => {
    if (node) node.classList.toggle('hidden', hidden);
  };

  const isPaused = () => !!el.pause && !el.pause.classList.contains('hidden');

  // A one-line status under the pause title: the wanted level and what the player is holding, which
  // is the only part of the world the pause screen has to show (main.js writes it on Esc).
  let pauseStatus = null;
  function setPauseStatus(text) {
    if (!el.pause) return;
    if (!pauseStatus) {
      pauseStatus = document.createElement('div');
      pauseStatus.id = 'pause-status';
      pauseStatus.style.cssText =
        'margin:-8px 0 18px;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;' +
        'color:#c8c1b3;text-align:center';
      el.pause.insertBefore(pauseStatus, el.pause.querySelector('.menu-actions'));
    }
    pauseStatus.textContent = text ? String(text) : '';
  }

  // ---- content -------------------------------------------------------------------------------
  if (el.story) el.story.textContent = START_STORY;

  function renderRows(panel, flexInline) {
    if (!panel) return;
    panel.textContent = '';
    for (const [key, label] of CONTROLS) {
      const row = document.createElement('div');
      if (flexInline) {
        // index.html styles #controls (and only #controls), so the pause copy borrows the same
        // look inline instead of inventing a second stylesheet.
        row.style.cssText = 'display:flex;justify-content:space-between;gap:18px;padding:3px 0';
      }
      const k = document.createElement('b');
      k.textContent = key;
      const v = document.createElement('span');
      v.textContent = label;
      row.append(k, v);
      panel.appendChild(row);
    }
  }

  renderRows(el.controls, false);
  renderRows(el.controls2, true);

  if (el.controls2) {
    // #controls2 ships with class "panel", which has no rule in index.html: start it closed and let
    // the plate look come from the same tokens #controls uses.
    el.controls2.style.display = 'none';
    el.controls2.style.cssText +=
      ';margin-top:14px;width:424px;font-size:12px;color:#c8c1b3;' +
      'background:rgba(9,16,26,0.7);border-left:2px solid var(--gold);padding:12px 14px';
  }

  // ---- controls panels -----------------------------------------------------------------------
  function togglePanel(panel, name) {
    if (!panel) return;
    if (name === 'controls') {
      const open = !panel.classList.contains('show');
      panel.classList.toggle('show', open);
      return;
    }
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }

  const closePanels = () => {
    if (el.controls) el.controls.classList.remove('show');
    if (el.controls2) el.controls2.style.display = 'none';
  };

  // ---- screens -------------------------------------------------------------------------------
  function showStart() {
    setHidden(el.pause, true);
    setHidden(el.start, false);
    closePanels();
  }

  function hideStart() {
    setHidden(el.start, true);
  }

  function showPause() {
    setHidden(el.start, true);
    setHidden(el.pause, false);
    closePanels();
  }

  function hidePause() {
    setHidden(el.pause, true);
    closePanels();
  }

  // ---- wiring --------------------------------------------------------------------------------
  let started = false;

  if (el.btnNew) {
    el.btnNew.addEventListener('click', () => {
      // the first click is the user gesture that may lock the pointer and open the audio context
      if (!started) {
        started = true;
        fire(onStart);
      }
      hideStart();
      fire(onNew);
    });
  }

  if (el.btnContinue) {
    el.btnContinue.addEventListener('click', () => {
      // same gesture rule as New game: this click may open audio and lock the pointer
      if (!started) {
        started = true;
        fire(onStart);
      }
      hideStart();
      fire(onContinue);
    });
  }

  if (el.btnSave) {
    el.btnSave.addEventListener('click', () => fire(onSave));
  }

  if (el.btnRetry) {
    el.btnRetry.addEventListener('click', () => fire(onRetry));
  }

  if (el.btnControls) {
    el.btnControls.addEventListener('click', () => togglePanel(el.controls, 'controls'));
  }

  if (el.btnControls2) {
    el.btnControls2.addEventListener('click', () => togglePanel(el.controls2, 'controls2'));
  }

  if (el.btnResume) {
    el.btnResume.addEventListener('click', () => {
      hidePause();
      fire(onResume);
    });
  }

  if (el.btnMenu) {
    el.btnMenu.addEventListener('click', () => {
      hidePause();
      showStart();
      fire(onQuit);
    });
  }

  // The title screen offers Continue only when a save actually validates: main.js decides, this
  // only reflects it.
  function setContinue(available, note = '') {
    if (!el.btnContinue) return;
    el.btnContinue.classList.toggle('hidden', !available);
    const small = el.btnContinue.querySelector('small');
    if (small && note) small.textContent = note;
  }

  return {
    showStart,
    hideStart,
    showPause,
    hidePause,
    isPaused,
    setPauseStatus,
    setContinue,
  };
}
