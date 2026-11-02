import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.13'
import { imagePlanRefusal } from './edge-image-plan.ts'

const resized = '<img data-image-src="{back}" sizes="auto, 100vw" loading="lazy" alt="">'

// An app with no card must still deploy, so only the attribute may demand a plan.
Deno.test('a release asks for a paid plan only of a screen using data-image-src', () => {
  assertEquals(imagePlanRefusal({ 'a.html': '<img src="{back}" alt="">' }, null), null)
  assertEquals(imagePlanRefusal({ 'a.html': '<img src="{back}" alt="">' }, { plan: 'free' }), null)
  assertEquals(imagePlanRefusal({ 'a.html': resized }, { plan: 'paid' }), null)
  assertStringIncludes(imagePlanRefusal({ 'b.html': resized, 'a.html': resized, 'c.html': '<p></p>' }, null)!, 'a.html, b.html use data-image-src')
  assertStringIncludes(imagePlanRefusal({ 'a.html': resized }, { plan: 'free' })!, 'plan: "paid"')
})
