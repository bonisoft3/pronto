// deno test --no-config --allow-read identity/brand_test.ts
import assert from 'node:assert/strict'
import { parseDesignFrontmatter, readAppBrand, sanitizeBrand } from './brand.ts'

Deno.test('sanitizeBrand accepts safe hex tokens and same-origin https logos, rejecting CSS injection and foreign URLs', () => {
  const safe = sanitizeBrand({
    name: 'Snapcards\n\tPress',
    logo: '/shell/favicon.svg',
    colors: {
      accent: '#B45309',
      surface: '#fff',
      injected: '#000',
      primary: 'red; background: url(https://evil.test)',
    },
    dark: { neutral: '#090E1780' },
  }, 'https://snapcards.bonisoft3.com')
  assert.deepEqual(safe, {
    name: 'SnapcardsPress',
    logo: 'https://snapcards.bonisoft3.com/shell/favicon.svg',
    colors: { accent: '#B45309', surface: '#fff' },
    dark: { neutral: '#090E1780' },
  })

  assert.equal(
    sanitizeBrand({ logo: 'https://evil.test/logo.svg' }, 'https://snapcards.bonisoft3.com'),
    null,
  )
  assert.equal(
    sanitizeBrand({ logo: 'javascript:alert(1)' }, 'https://snapcards.bonisoft3.com'),
    null,
  )
})

Deno.test('parseDesignFrontmatter extracts colors and dark palettes from DESIGN.md', () => {
  const parsed = parseDesignFrontmatter(`---
colors:
  primary: "#191C24"
  accent: '#B45309'
  # comment
  surface-muted: #F5F2EB
dark:
  primary: "#F7F5F0"
shell:
  nav: "sidebar"
---
# Heading
`)
  assert.deepEqual(parsed, {
    colors: { primary: '#191C24', accent: '#B45309', 'surface-muted': '#F5F2EB' },
    dark: { primary: '#F7F5F0' },
  })
})

Deno.test('readAppBrand reads snapcards brand metadata', async () => {
  const snapcardsDir = new URL('../../../apps/snapcards', import.meta.url).pathname
  const brand = await readAppBrand(snapcardsDir, 'https://snapcards.bonisoft3.com')
  assert.equal(brand?.name, 'snapcards')
  assert.equal(brand?.colors?.accent, '#B45309')
  assert.equal(brand?.dark?.accent, '#FBBF24')
})
