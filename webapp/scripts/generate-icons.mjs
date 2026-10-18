// Rasterize the code-native SVG at install-manifest sizes. No external assets.
import { chromium } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined) })
try {
  const svg = await readFile(new URL('../public/icons/app.svg', import.meta.url), 'utf8')
  const page = await browser.newPage()
  for (const [size, name] of [[192, 'app-192'], [512, 'app-512'], [180, 'apple-touch-icon']]) {
    const png = await page.evaluate(async ({ svg, size }) => {
      const image = new Image()
      image.src = `data:image/svg+xml;base64,${btoa(svg)}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      canvas.getContext('2d').drawImage(image, 0, 0, size, size)
      return canvas.toDataURL('image/png').split(',')[1]
    }, { svg, size })
    await writeFile(new URL(`../public/icons/${name}.png`, import.meta.url), Buffer.from(png, 'base64'))
  }
} finally { await browser.close() }
