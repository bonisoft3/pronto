/** Why this release refuses its screens' data-image-src, or null. A screen that uses it
 * asks Cloudflare Images for paid transformations; an app that never does needs no card. */
export function imagePlanRefusal(screens: Record<string, string>, images: { plan: 'free' | 'paid' } | null): string | null {
  if (images?.plan === 'paid') return null
  const using = Object.keys(screens).filter((name) => /\sdata-image-src=/.test(screens[name])).sort()
  if (using.length === 0) return null
  return `${using.join(', ')} use data-image-src, which needs Cloudflare Images on a paid plan: declare code.capabilities.edgeImages with plan: "paid" (a card, and a subscription under Media -> Images -> Plans), or bind a plain src`
}
