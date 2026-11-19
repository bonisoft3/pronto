import { strict as assert } from 'node:assert'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { buildNativeApp } from './native.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const snapcardsDir = path.join(repoRoot, 'apps/snapcards')
const omnishellDir = path.join(repoRoot, 'plugins/omnishell')
const mechaDir = path.join(repoRoot, 'libraries/mecha')

Deno.test('buildNativeApp emits TWA-compatible Android Gradle project and iOS SwiftPM bundle with pre-seeded offline caches & curated derived.sql', async () => {
  const tmpRoot = await Deno.makeTempDir({ prefix: 'pronto-native-bundle-' })
  try {
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))
    const expectedPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
    let bin = ''
    for (let i = 0; i < expectedPubRaw.length; i++) bin += String.fromCharCode(expectedPubRaw[i])
    const expectedPubB64 = btoa(bin)

    const androidOut = path.join(tmpRoot, 'android')
    const androidRes = await buildNativeApp({
      appDir: snapcardsDir,
      platform: 'android',
      omnishellDir,
      mechaDir,
      outDir: androidOut,
      domain: 'snapcards.fun',
      ed25519PrivateKeyPkcs8: pkcs8,
    })

    // Preserves existing Play App Signing TWA package identity for seamless in-place upgrades.
    assert.equal(androidRes.applicationId, 'app.hosted.us_central1.flashcards__trash_362115.twa')
    assert.equal(androidRes.publicKeyBase64, expectedPubB64)
    assert.ok(androidRes.nativeBridgeAddress.startsWith('/_immutable-'))
    assert.equal(androidRes.seededShapes.card_set, 8)
    assert.equal(androidRes.seededShapes.flashcard, 82)
    assert.equal(androidRes.seededShapes.deck_stats, 8)

    const appGradle = await Deno.readTextFile(path.join(androidOut, 'app/build.gradle.kts'))
    assert.ok(appGradle.includes('applicationId = "app.hosted.us_central1.flashcards__trash_362115.twa"'))
    const androidManifest = await Deno.readTextFile(path.join(androidOut, 'app/src/main/AndroidManifest.xml'))
    assert.ok(androidManifest.includes('android:autoVerify="true"'))
    assert.ok(androidManifest.includes('android:host="snapcards.fun"'))
    assert.ok(androidManifest.includes('android:scheme="snapcards"'))
    assert.ok(androidManifest.includes('android:pathPrefix="/return"'))

    // Verify pre-seeded SQLite statements execute cleanly and populate pronto-entries-v1, pronto-addressed-v1, and mecha_shape_row.
    const cacheSql = await Deno.readTextFile(path.join(androidOut, 'app/src/main/assets/seed-cache.sql'))
    const derivedSql = await Deno.readTextFile(path.join(androidOut, 'app/src/main/assets/derived.sql'))
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(cacheSql)
    sqlite.exec(derivedSql)

    const entryRow = sqlite
      .prepare("SELECT body FROM omnishell_http_cache WHERE cache_name = 'pronto-entries-v1' AND pathname = '/'")
      .get() as { body: string } | undefined
    assert.ok(entryRow?.body.includes('<meta name="pronto-kept">'))
    assert.ok(entryRow?.body.includes(`data-signature="${androidRes.signatureBase64}"`))

    const divkitCached = sqlite
      .prepare("SELECT COUNT(*) AS cnt FROM omnishell_http_cache WHERE cache_name = 'pronto-addressed-v1' AND pathname LIKE '%.divkit.json'")
      .get() as { cnt: number }
    assert.ok(Number(divkitCached.cnt) >= 7)

    const bridgeCached = sqlite
      .prepare("SELECT body FROM omnishell_http_cache WHERE cache_name = 'pronto-addressed-v1' AND pathname = ?")
      .get(androidRes.nativeBridgeAddress) as { body: string } | undefined
    assert.ok(bridgeCached?.body.includes(androidRes.nativeBridgeAddress))

    const seededDecks = sqlite
      .prepare("SELECT COUNT(*) AS cnt FROM mecha_shape_row WHERE shape_id = 'card_set' AND subject = ''")
      .get() as { cnt: number }
    assert.equal(Number(seededDecks.cnt), 8)
    sqlite.close()

    // iOS target: bundle ID fun.snapcards.app, Associated Domains, Sign in with Apple entitlement, and identical bridge ABI.
    const iosOut = path.join(tmpRoot, 'ios')
    const iosRes = await buildNativeApp({
      appDir: snapcardsDir,
      platform: 'ios',
      omnishellDir,
      mechaDir,
      outDir: iosOut,
      domain: 'snapcards.fun',
      ed25519PrivateKeyPkcs8: pkcs8,
    })

    assert.equal(iosRes.bundleIdentifier, 'fun.snapcards.app')
    assert.equal(iosRes.nativeBridgeAddress, androidRes.nativeBridgeAddress)
    assert.equal(iosRes.publicKeyBase64, expectedPubB64)

    const xcconfig = await Deno.readTextFile(path.join(iosOut, 'Config/App.xcconfig'))
    assert.ok(xcconfig.includes('PRODUCT_BUNDLE_IDENTIFIER = fun.snapcards.app'))
    const entitlements = await Deno.readTextFile(path.join(iosOut, 'App/App.entitlements'))
    assert.ok(entitlements.includes('applinks:snapcards.fun'))
    assert.ok(entitlements.includes('com.apple.developer.applesignin'))
    const infoPlist = await Deno.readTextFile(path.join(iosOut, 'App/Info.plist'))
    assert.ok(infoPlist.includes('<string>snapcards</string>'))

    const printDivkit = JSON.parse(
      await Deno.readTextFile(path.join(iosOut, 'Sources/SnapcardsApp/Resources/screens/print.divkit.json')),
    ) as { card: { log_id: string } }
    assert.equal(printDivkit.card.log_id, 'omnishell_print')
  } finally {
    await Deno.remove(tmpRoot, { recursive: true }).catch(() => {})
  }
})
