/**
 * The presentation sheet as the page fetches it (plus/panel.ts imports this file on demand, never with the page): its styles, the sheet
 * (sheet.ts), and the demo mounted in its stage once it opens: the interactive demo with the page's own levels control on the demo's store
 * (`demoControl`: never the visitor's settings, no Split), and the three feature pictures. Kept apart from sheet.ts so that the sheet itself
 * can be tested without styles.
 */
import './present.css';
import './sheet.css';
import { mountDemo, mountVisuals } from './demo/index.ts';
import { demoControl } from './demo-levels.ts';
import { demoWith, openSheet } from './sheet.ts';

demoWith((stage, visuals) => {
  const demo = mountDemo(stage, { control: demoControl });
  const pictures = mountVisuals(visuals);
  return { destroy: () => { demo.destroy(); pictures.destroy(); } };
});

export { openSheet };
