/**
 * The frame-rate panel's "Copy for AI" report (2026-11-14, Karl: "a very detailed guide for the user that he can also copy for his AI agent to
 * solve the problem at his end"). English, for an assistant: what the page measured, then what to check, most likely first, with where each
 * setting is in each browser and system. Pure: the meter gathers `SpeedInfo`. What it carries (the browser and system from the user agent,
 * the graphics card, the screen and window sizes, processor threads and memory, the page's settings) is what the copy button's tip lists
 * before anything is copied; the page's address only where it is the public site's (`pageAddress`).
 */
import type { FrameStats } from './model.ts';

/** How the map draws: WebGL2, a 2D canvas because the browser gave no WebGL2, or a 2D canvas because WebGL2 could not draw it. */
export type Graphics = 'webgl2' | 'no-webgl2' | 'failed';

export interface SpeedInfo {
  stats: FrameStats;
  graphics: Graphics;
  /** The graphics card as the browser names it (WebGL's renderer string), when it gives one. */
  gpu: string | null;
  userAgent: string;
  /** The screen in CSS pixels and its device pixels to a CSS pixel. */
  screen: { w: number; h: number; ratio: number };
  /** The browser window's inside, in CSS pixels. */
  window: { w: number; h: number };
  cores: number | null;
  /** The device's memory in GB as the browser rounds it (Chrome only), or null. */
  memoryGb: number | null;
  /** The page's own settings that cost the most to draw. */
  glass: boolean;
  panels: string[];
  timeframe: string;
  /** Where the page was opened (`pageAddress`). */
  url: string;
}

const round = (v: number): string => String(Math.round(v));

/** The panes the report names when they are open (the page's `show` switches), in English for the assistant. */
export const PANEL_NAMES: readonly (readonly [string, string])[] = [
  ['cvd', 'flow column'], ['book', 'order book'], ['depth', 'depth'], ['oi', 'open interest'], ['delta', 'delta'], ['ls', 'long/short'], ['lt', 'liquidity tracker'], ['footprint', 'footprint'],
];
/** The open panes' names from the page's switches. */
export const openPanels = (show: Readonly<Record<string, boolean>>): string[] => PANEL_NAMES.filter(([key]) => show[key]).map(([, name]) => name);

/** What the report calls the page's address: the public site's own; a copy opened anywhere else (a file, a local or private server) is not named. */
export const LOCAL_COPY = 'a copy of the page on this computer or network';
export function pageAddress(hostname: string, origin: string, pathname: string): string {
  return /(?:^|\.)liquiditymapper\.com$|\.github\.io$|\.pages\.dev$/.test(hostname) ? `${origin}${pathname}` : LOCAL_COPY;
}

export function speedReport(info: SpeedInfo): string {
  const s = info.stats, fps = s.fps === null ? 'still measuring' : `${s.fps} frames a second in the last second, ${s.fpsMinute ?? s.fps} on average over the last ${round(s.seenSeconds)} s${s.fpsMost !== null ? `, at least ${s.fpsMost} in three seconds of four` : ''}`;
  const graphics = info.graphics === 'webgl2'
    ? `WebGL2 is on: the heatmap is drawn by the graphics card${info.gpu ? ` (${info.gpu})` : ''}`
    : info.graphics === 'no-webgl2'
      ? `the browser gives the page no WebGL2, so the heatmap is drawn on the processor (slower), and the page's Live trades and Glass look are off${info.gpu ? `; the browser names the graphics card as ${info.gpu}` : ''}`
      : `WebGL2 is there but could not draw the heatmap (a shader the driver refused), so the heatmap is drawn on the processor${info.gpu ? `; graphics card: ${info.gpu}` : ''}`;
  const sw = info.screen.w, sh = info.screen.h, r = info.screen.ratio;
  const lines: string[] = [
    '# Help me make LiquidityMapperFast run smoothly in my browser',
    '',
    `I use LiquidityMapperFast (${info.url}), a live crypto order-book heatmap that runs in the browser. It draws the heatmap with WebGL2 and the order book, the tape and the panels on 2D canvases, and it measures its own frame rate. Please help me make it run at my screen's rate: go step by step, tell me exactly where each setting is for my browser and system, ask me to check one thing at a time, and wait for my answer before the next step.`,
    '',
    '## What the page measured',
    `- Frame rate: ${fps}; the screen runs at about ${s.hz} Hz (read from the frames of the last minute).`,
    `- Late frames in the last ${round(s.seenSeconds)} s: ${s.lateMinute} (a frame is late when it takes over one and a half frames' time); the longest took ${round(s.worstMinute)} ms.`,
    `- Graphics: ${graphics}.`,
    `- Browser: ${info.userAgent}`,
    `- Screen: ${sw} x ${sh} CSS pixels at ${r} device pixels each (about ${round(sw * r)} x ${round(sh * r)} device pixels); the browser window's inside is ${info.window.w} x ${info.window.h} CSS pixels.${info.cores ? ` The browser reports ${info.cores} processor threads` : ''}${info.memoryGb ? ` and about ${info.memoryGb} GB of memory` : ''}${info.cores || info.memoryGb ? '.' : ''}`,
    `- The page: ${info.glass ? 'the Glass look (Waves) is on' : 'the plain (Solid) look'}; panels open: ${info.panels.join(', ') || 'the map alone'}; timeframe ${info.timeframe}.`,
    '',
    '## What to check, most likely first',
  ];
  const acceleration = 'Hardware (graphics) acceleration. Chrome: Settings > System > "Use graphics acceleration when available", then Relaunch. Edge: Settings > System and performance > "Use graphics acceleration when available", then Restart. Firefox: Settings > General > Performance: untick "Use recommended performance settings", tick "Use hardware acceleration when available", then restart. Safari always uses it.';
  const report = 'The browser\'s graphics report. Chrome: open chrome://gpu (Edge: edge://gpu) and look at "Graphics Feature Status": WebGL2 should say "Hardware accelerated"; "Software only" or "Unavailable" means the browser has switched the graphics card off for itself, and the "Problems Detected" list says why (an old or blocked driver, or a crash of the graphics process). Firefox: open about:support and read the Graphics section (WebGL 2 renderer, and any failures it lists).';
  const driver = 'The graphics driver: update it from the card\'s maker (NVIDIA App, AMD Software: Adrenalin Edition, Intel Driver & Support Assistant) or Windows Update; on a Mac, the macOS updates carry it. Restart the browser afterwards.';
  const steps: string[] = [];
  // Without WebGL2, acceleration is likely off; where WebGL2 is there but could not draw, acceleration is on and the driver is the suspect.
  if (info.graphics === 'no-webgl2') steps.push(acceleration, report, driver);
  else if (info.graphics === 'failed') steps.push(driver, report);
  steps.push(
    'Energy saving, which caps frame rates: Chrome\'s Energy Saver (Settings > Performance) holds pages to fewer frames on battery; Windows\' power mode (Settings > System > Power & battery) should be "Best performance" while plugged in; on a Mac, Low Power Mode should be off.',
    'The screen\'s own rate: Windows: Settings > System > Display > Advanced display > "Choose a refresh rate"; macOS: System Settings > Displays > Refresh Rate. With several screens, keep the page on the fastest one.',
    'Other load: tabs and programs that draw (video, games, other live charts) share the processor and the graphics card. The browser\'s task manager shows which tab or extension uses them: Chrome and Edge, Shift+Esc on Windows and Linux (on a Mac, Chrome\'s Window > Task Manager); Firefox, about:processes.',
    'Browser extensions that read every page can slow drawing: try the page in a new window with extensions off (a private window, with extensions not allowed there).',
    `In the page itself: ${info.glass ? 'switch Waves off (it turns the panels to glass and draws them on every frame); ' : ''}close the panels you do not use (each one draws as the market moves); a smaller window draws fewer pixels.`,
  );
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push('', 'When we are done, the page\'s meter (the LED window at the left end of its status bar) should read close to the screen\'s rate, in green.');
  return lines.join('\n');
}
