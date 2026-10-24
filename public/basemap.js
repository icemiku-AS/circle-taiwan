export function terrainPixels(heights, width, height, cell = 100) {
  if (heights.length !== width * height || width < 2 || height < 2) throw new Error('地形資料尺寸錯誤');
  const pixels = new Uint8ClampedArray(width * height * 4);
  const value = (x, y, fallback) => { const n = heights[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))]; return n === 65535 ? fallback : n; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, h = heights[i]; if (h === 65535) continue;
    const dx = (value(x + 1, y, h) - value(x - 1, y, h)) / (2 * cell), dy = (value(x, y - 1, h) - value(x, y + 1, h)) / (2 * cell);
    const light = (-dx * -.5 - dy * .5 + .707) / Math.hypot(dx, dy, 1);
    const shade = .86 + light * .21, elevation = Math.min(1, h / 3500), p = i * 4;
    pixels[p] = (220 - elevation * 20) * shade; pixels[p + 1] = (229 - elevation * 29) * shade;
    pixels[p + 2] = (211 - elevation * 26) * shade; pixels[p + 3] = 255;
  }
  return pixels;
}
