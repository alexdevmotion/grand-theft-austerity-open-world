import { createGame } from './game';
import { t } from './core/i18n';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const boot = document.getElementById('boot')!;
const bootFill = document.getElementById('boot-fill')!;
const bootStatus = document.getElementById('boot-status')!;
const fatal = document.getElementById('fatal')!;

function showFatal(err: unknown): void {
  const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  fatal.textContent = `${t('GRAND THEFT AUSTERITY — eroare fatală')}\n\n${msg}`;
  (fatal as HTMLElement).style.display = 'block';
  boot.classList.add('hidden');
  console.error(err);
}

window.addEventListener('error', (e) => showFatal(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

const STATUS_LINES: Record<string, string> = {
  physics: 'SE CALIBREAZĂ GRAVITAȚIA',
  sky: 'SE APRINDE APUSUL',
  city: 'SE CONSTRUIEȘTE BUCUREȘTIUL',
  streaming: 'SE ÎNCARCĂ CARTIERELE',
  vehicles: 'SE PORNEȘTE DACIA',
  traffic: 'SE UMPLE TRAFICUL',
  peds: 'IES OAMENII ÎN STRADĂ',
  player: 'SE TREZEȘTE BOLOJAN-AGATINEI',
  wanted: 'MINISTERUL DE-ACCELERĂRII SE MOBILIZEAZĂ',
  missions: 'SE SCRIE DOSARUL',
  hud: 'SE APRINDE INTERFAȚA',
  audio: 'SE DESCHIDE RADIOUL',
  postfx: 'SE GRADEAZĂ IMAGINEA',
};

async function boot_() {
  // `index.html` ships the Romanian status line so the card is never blank
  // before the bundle parses. Restate it now that the stored language is known.
  bootStatus.textContent = t('SE ÎNCARCĂ BUCUREȘTIUL…');

  try {
    const game = await createGame(canvas, (done, total, name) => {
      const pct = Math.round((done / Math.max(1, total)) * 100);
      (bootFill as HTMLElement).style.width = `${pct}%`;
      bootStatus.textContent = t(STATUS_LINES[name] ?? name.toUpperCase());
    });

    (window as unknown as { __GAME__: unknown }).__GAME__ = game;

    boot.classList.add('hidden');
    setTimeout(() => ((boot as HTMLElement).style.display = 'none'), 700);

    game.start();
  } catch (err) {
    showFatal(err);
  }
}

void boot_();
