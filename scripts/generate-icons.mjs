// One-time icon pipeline for PWA support. Not part of `vite build` and never
// runs on Vercel -- run manually (`node scripts/generate-icons.mjs`) whenever
// the source artwork changes, and commit the generated PNGs.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'materials', 'Work-Organizer Icon.jpeg');
const OUT_DIR = path.join(root, 'public', 'icons');

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // The source is already a finished square app-icon design (dark
  // background, rounded corners baked in) -- plain "any" icons are a
  // straight resize, no padding/flattening needed.
  await sharp(SOURCE).resize(192, 192).png().toFile(path.join(OUT_DIR, 'icon-192.png'));
  await sharp(SOURCE).resize(512, 512).png().toFile(path.join(OUT_DIR, 'icon-512.png'));
  await sharp(SOURCE).resize(180, 180).png().toFile(path.join(OUT_DIR, 'apple-touch-icon.png'));
  await sharp(SOURCE).resize(32, 32).png().toFile(path.join(OUT_DIR, 'favicon-32.png'));

  // Maskable: Android's mask can crop up to the outer ~20% of a full-bleed
  // icon, and this artwork's glow ring sits close to the edge -- pad it down
  // into the inner 80% safe zone on a canvas sampled from the source's own
  // corner pixel, so there's no visible seam between canvas and artwork.
  const { data: cornerPixel } = await sharp(SOURCE)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const background = { r: cornerPixel[0], g: cornerPixel[1], b: cornerPixel[2] };

  const inner = Math.round(512 * 0.8);
  const padded = await sharp(SOURCE).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 3, background } })
    .composite([{ input: padded, gravity: 'center' }])
    .png()
    .toFile(path.join(OUT_DIR, 'maskable-512.png'));

  console.log('Icons written to', OUT_DIR);
}

main();
