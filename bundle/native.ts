// Builds a pronto app's native Android (Gradle) or iOS (SwiftPM/Xcode) bundle
// with pre-seeded offline SWR caches (pronto-entries-v1, pronto-addressed-v1),
// Ed25519-signed #pronto-assets manifest, and pre-populated SQLite shape rows
// (derived.sql) so cold offline installs render curated state with zero network.
//
//   deno run -A --config bundle/deno.json bundle/native.ts <appDir> --platform <android|ios> --omnishell <dir> --mecha <dir> [--out <dir>] [--domain <host>] [--derived <file>] [--android-package <id>] [--ios-bundle-id <id>] [--ice-servers <json>]

import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyHatchAttributes, readEdgeHatches } from './edge-hatches.ts'
import { type StaticAsset, writeEdgeAssets } from './edge-assets.ts'
import { addressEdgeAssets, realmSubdomains, releaseAddresses } from './edge-addresses.ts'
import { builtRelease, holdIceServers } from './edge-ice.ts'

export type NativePlatform = 'android' | 'ios'

export interface BuildNativeOptions {
  appDir: string
  platform: NativePlatform
  omnishellDir: string
  mechaDir: string
  outDir?: string
  domain?: string
  derivedFile?: string
  androidPackage?: string
  iosBundleId?: string
  iceServersJson?: string
  ed25519PrivateKeyPkcs8?: Uint8Array
}

export interface NativeSeedBundle {
  app: string
  platform: NativePlatform
  origin: string
  scheme: string
  publicKeyBase64: string
  signatureBase64: string
  nativeBridgeAddress: string
  entryPaths: string[]
  entryHtml: string
  addressedAssets: Record<string, { body: string; contentType: string }>
  seededShapes: Record<string, number>
}

export interface BuildNativeResult {
  outDir: string
  platform: NativePlatform
  applicationId?: string
  bundleIdentifier?: string
  publicKeyBase64: string
  signatureBase64: string
  nativeBridgeAddress: string
  entryPaths: string[]
  addressedCount: number
  seededShapes: Record<string, number>
}

const DEFAULT_ICE_SERVERS_JSON = '[{"urls":"stun:stun.cloudflare.com:3478"}]'
const SERVED_READS_RE = /<script type="application\/json" id="pronto-reads">[\s\S]*?<\/script>/
const HEAD_OPEN_RE = /<head\b[^>]*>/i
const PRONTO_KEPT_RE = /<meta\b[^>]*\bname=["']pronto-kept["'][^>]*>/i

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const TEXT_RUNTIME_ASSET_RE = /\.(json|js|mjs|css|html|txt|svg|xml|webmanifest)$/i

function sqlQuote(value: string): string {
  return `'${value.replaceAll('\0', '').replaceAll("'", "''")}'`
}

function stampProntoKept(html: string): string {
  const withoutReads = html.replace(SERVED_READS_RE, '')
  if (PRONTO_KEPT_RE.test(withoutReads)) return withoutReads
  if (HEAD_OPEN_RE.test(withoutReads)) {
    return withoutReads.replace(HEAD_OPEN_RE, (head) => `${head}<meta name="pronto-kept">`)
  }
  return `<head><meta name="pronto-kept"></head>${withoutReads}`
}

function contentTypeForAsset(assetPath: string): string {
  const clean = assetPath.split('?')[0].toLowerCase()
  if (clean.endsWith('.json')) return 'application/json; charset=utf-8'
  if (clean.endsWith('.js') || clean.endsWith('.mjs')) return 'application/javascript; charset=utf-8'
  if (clean.endsWith('.css')) return 'text/css; charset=utf-8'
  if (clean.endsWith('.html') || clean.endsWith('.txt')) return 'text/html; charset=utf-8'
  if (clean.endsWith('.svg')) return 'image/svg+xml'
  if (clean.endsWith('.webp')) return 'image/webp'
  if (clean.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

async function resolveSigningKeys(providedPkcs8?: Uint8Array): Promise<{
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicKeyBase64: string
}> {
  const envPkcs8 = Deno.env.get('NATIVE_MANIFEST_ED25519_PKCS8')?.trim() ?? ''
  const pkcs8 = providedPkcs8 ?? (envPkcs8 ? base64ToBytes(envPkcs8) : undefined)
  if (pkcs8) {
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(pkcs8),
      { name: 'Ed25519' },
      true,
      ['sign'],
    )
    const jwk = await crypto.subtle.exportKey('jwk', privateKey)
    if (!jwk.x) throw new Error('Ed25519 PKCS#8 key did not export public coordinate x')
    const pubRaw = base64ToBytes(jwk.x)
    const publicKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(pubRaw),
      { name: 'Ed25519' },
      true,
      ['verify'],
    )
    return { privateKey, publicKey, publicKeyBase64: bytesToBase64(pubRaw) }
  }
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    publicKeyBase64: bytesToBase64(pubRaw),
  }
}

async function collectNativeBridgeBytes(omnishell: string): Promise<Uint8Array> {
  const bridgeFiles: string[] = []
  for (const sub of ['android/src/main/kotlin/com/pronto/omnishell/bridge', 'ios/Sources/Omnishell/bridge']) {
    const dir = path.join(omnishell, sub)
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile) bridgeFiles.push(path.join(dir, entry.name))
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e
    }
  }
  bridgeFiles.sort()
  const parts: Uint8Array[] = []
  for (const f of bridgeFiles) parts.push(await Deno.readFile(f))
  const total = parts.reduce((n, b) => n + b.length, 0)
  const combined = new Uint8Array(total)
  let offset = 0
  for (const b of parts) {
    combined.set(b, offset)
    offset += b.length
  }
  return combined
}

async function discoverAndroidTarget(webDir: string, overridePackage?: string): Promise<{
  applicationId: string
  certFingerprints: string[]
}> {
  let discoveredPkg = ''
  const fingerprints = new Set<string>()
  try {
    const raw = await Deno.readTextFile(path.join(webDir, '.well-known/assetlinks.json'))
    const statements = JSON.parse(raw) as Array<{
      target?: { namespace?: string; package_name?: string; sha256_cert_fingerprints?: string[] }
    }>
    if (Array.isArray(statements)) {
      for (const stmt of statements) {
        if (stmt?.target?.namespace !== 'android_app') continue
        if (!discoveredPkg && typeof stmt.target.package_name === 'string' && stmt.target.package_name.trim()) {
          discoveredPkg = stmt.target.package_name.trim()
        }
        for (const fp of stmt.target.sha256_cert_fingerprints ?? []) {
          if (typeof fp === 'string' && fp.trim()) fingerprints.add(fp.trim())
        }
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e
  }
  const applicationId = (overridePackage ?? discoveredPkg).trim()
  if (!applicationId) {
    throw new Error('Android package name is not declared in .well-known/assetlinks.json and --android-package was not provided')
  }
  return { applicationId, certFingerprints: [...fingerprints] }
}

async function discoverIosBundleId(webDir: string, overrideBundleId?: string): Promise<string> {
  if (overrideBundleId?.trim()) return overrideBundleId.trim()
  try {
    const raw = await Deno.readTextFile(path.join(webDir, '.well-known/apple-app-site-association'))
    const parsed = JSON.parse(raw) as {
      applinks?: { details?: Array<{ appID?: string; appIDs?: string[] }> }
      webcredentials?: { apps?: string[] }
    }
    const candidates: string[] = []
    for (const detail of parsed.applinks?.details ?? []) {
      if (typeof detail.appID === 'string') candidates.push(detail.appID)
      for (const id of detail.appIDs ?? []) {
        if (typeof id === 'string') candidates.push(id)
      }
    }
    for (const app of parsed.webcredentials?.apps ?? []) {
      if (typeof app === 'string') candidates.push(app)
    }
    for (const candidate of candidates) {
      const trimmed = candidate.trim()
      if (!trimmed) continue
      const teamPrefixed = /^[A-Z0-9]{10}\.(.+)$/.exec(trimmed)
      return teamPrefixed ? teamPrefixed[1] : trimmed
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e
  }
  throw new Error('iOS bundle identifier is not declared in .well-known/apple-app-site-association and --ios-bundle-id was not provided')
}

interface ExportedEntitySeed {
  pk: string
  durability: string
  scope: string
  seed: Array<Record<string, unknown>>
}

async function exportEntitySeeds(appDir: string): Promise<Record<string, ExportedEntitySeed>> {
  const expr = `{
    entities: {
      for _, e in code.state.entities {
        (e.table): {
          fields: [for f in e.fields {name: f.name, pk: [if f.pk != _|_ {f.pk}, false][0]}]
          durability: e.durability
          scope: [if e.access != _|_ if e.access.scope != _|_ {e.access.scope}, "public"][0]
          seed: [if e.seed != _|_ {e.seed}, []][0]
        }
      }
    }
  }`
  const out = await new Deno.Command('cue', {
    args: ['export', '.', '-e', expr, '--out', 'json'],
    cwd: appDir,
    stdout: 'piped',
    stderr: 'inherit',
  }).output()
  if (!out.success) throw new Error('cue export of code.state.entities seed rows failed')
  const parsed = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    entities: Record<string, { fields: Array<{ name: string; pk: boolean }>; durability: string; scope: string; seed: Array<Record<string, unknown>> }>
  }
  const entities: Record<string, ExportedEntitySeed> = {}
  for (const [table, raw] of Object.entries(parsed.entities ?? {})) {
    const pk = raw.fields.find((f) => f.pk)?.name ?? raw.fields[0]?.name ?? 'id'
    entities[table] = {
      pk,
      durability: raw.durability,
      scope: raw.scope,
      seed: raw.seed ?? [],
    }
  }

  // Populate deck_stats cover and zeroed counters from curated CardSet + Flashcard seeds when present.
  if (entities.deck_stats && entities.deck_stats.seed.length === 0 && entities.card_set?.seed?.length) {
    const flashcards = entities.flashcard?.seed ?? []
    entities.deck_stats.seed = entities.card_set.seed.map((deck) => {
      const deckId = String(deck.id ?? '')
      const firstCard = flashcards.find((c) => String(c.set_id ?? '') === deckId)
      return {
        deck_id: deckId,
        favorite_count: 0,
        counted_txid: '0',
        cover: typeof firstCard?.back === 'string' ? firstCard.back : '',
      }
    })
  }
  return entities
}

function renderDerivedSql(entities: Record<string, ExportedEntitySeed>, extraSql?: string): {
  sql: string
  seededShapes: Record<string, number>
} {
  const lines: string[] = [
    '-- Pre-seeded SQLite shape snapshots for offline cold boot (SqliteShapeSnapshotStore).',
    'CREATE TABLE IF NOT EXISTS mecha_shape_row (',
    '  shape_id TEXT NOT NULL,',
    '  subject TEXT NOT NULL,',
    '  row_key TEXT NOT NULL,',
    '  row_json TEXT NOT NULL,',
    '  seq INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  UNIQUE (shape_id, subject, row_key)',
    ');',
    'CREATE TABLE IF NOT EXISTS mecha_shape_meta (',
    '  shape_id TEXT NOT NULL,',
    '  subject TEXT NOT NULL,',
    '  updated_at INTEGER NOT NULL,',
    '  PRIMARY KEY (shape_id, subject)',
    ');',
  ]
  const seededShapes: Record<string, number> = {}
  const sortedTables = Object.keys(entities).sort()
  for (const table of sortedTables) {
    const info = entities[table]
    if (info.scope !== 'public') continue
    if (info.durability !== 'live' && info.durability !== 'shared' && info.seed.length === 0) continue
    for (const row of info.seed) {
      const keyVal = String(row[info.pk] ?? '')
      if (!keyVal) continue
      lines.push(
        `INSERT INTO mecha_shape_row (shape_id, subject, row_key, row_json) VALUES (${sqlQuote(table)}, '', ${sqlQuote(keyVal)}, ${sqlQuote(JSON.stringify(row))}) ON CONFLICT(shape_id, subject, row_key) DO UPDATE SET row_json = excluded.row_json;`,
      )
    }
    lines.push(
      `INSERT INTO mecha_shape_meta (shape_id, subject, updated_at) VALUES (${sqlQuote(table)}, '', 1) ON CONFLICT(shape_id, subject) DO UPDATE SET updated_at = excluded.updated_at;`,
    )
    seededShapes[table] = info.seed.length
  }
  if (extraSql?.trim()) {
    lines.push('', '-- Additional derived SQL', extraSql.trim())
  }
  return { sql: lines.join('\n') + '\n', seededShapes }
}

function renderSeedCacheSql(
  origin: string,
  entryPaths: string[],
  stampedEntryHtml: string,
  addressedAssets: Record<string, { body: string; contentType: string }>,
): string {
  const cleanOrigin = origin.replace(/\/+$/, '')
  const lines: string[] = [
    '-- Pre-seeded offline-first-sw CacheStorage tables (pronto-entries-v1 & pronto-addressed-v1).',
    'CREATE TABLE IF NOT EXISTS omnishell_cache_names (cache_name TEXT PRIMARY KEY);',
    'CREATE TABLE IF NOT EXISTS omnishell_http_cache (',
    '  cache_name TEXT NOT NULL,',
    '  url TEXT NOT NULL,',
    '  pathname TEXT NOT NULL,',
    '  status INTEGER NOT NULL,',
    '  status_text TEXT NOT NULL,',
    '  headers_json TEXT NOT NULL,',
    '  body TEXT NOT NULL,',
    '  PRIMARY KEY (cache_name, url)',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_omnishell_http_cache_path ON omnishell_http_cache (cache_name, pathname);',
    "INSERT OR IGNORE INTO omnishell_cache_names (cache_name) VALUES ('pronto-entries-v1');",
    "INSERT OR IGNORE INTO omnishell_cache_names (cache_name) VALUES ('pronto-addressed-v1');",
  ]
  const entryHeaders = JSON.stringify({ 'content-type': 'text/html; charset=utf-8' })
  for (const rawPath of entryPaths) {
    const pathname = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    const fullUrl = `${cleanOrigin}${pathname}`
    lines.push(
      `INSERT OR REPLACE INTO omnishell_http_cache (cache_name, url, pathname, status, status_text, headers_json, body) VALUES ('pronto-entries-v1', ${sqlQuote(fullUrl)}, ${sqlQuote(pathname)}, 200, 'OK', ${sqlQuote(entryHeaders)}, ${sqlQuote(stampedEntryHtml)});`,
    )
  }
  for (const [rawAssetPath, asset] of Object.entries(addressedAssets)) {
    const pathname = rawAssetPath.startsWith('/') ? rawAssetPath : `/${rawAssetPath}`
    const fullUrl = `${cleanOrigin}${pathname}`
    const headers = JSON.stringify({
      'content-type': asset.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    })
    lines.push(
      `INSERT OR REPLACE INTO omnishell_http_cache (cache_name, url, pathname, status, status_text, headers_json, body) VALUES ('pronto-addressed-v1', ${sqlQuote(fullUrl)}, ${sqlQuote(pathname)}, 200, 'OK', ${sqlQuote(headers)}, ${sqlQuote(asset.body)});`,
    )
  }
  return lines.join('\n') + '\n'
}

function pascalCase(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9]+/g, ' ').trim()
  if (!cleaned) return 'ProntoApp'
  return cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

async function emitAndroidProject(params: {
  outDir: string
  omnishellDir: string
  appName: string
  displayName: string
  applicationId: string
  certFingerprints: string[]
  domain: string
  origin: string
  scheme: string
  publicKeyBase64: string
  signatureBase64: string
  nativeBridgeAddress: string
  seedBundle: NativeSeedBundle
  seedCacheSql: string
  derivedSql: string
  divkitScreens: Record<string, unknown>
  hostRuntimeJs: string
}): Promise<void> {
  const {
    outDir,
    omnishellDir,
    appName,
    displayName,
    applicationId,
    certFingerprints,
    domain,
    origin,
    scheme,
    publicKeyBase64,
    signatureBase64,
    nativeBridgeAddress,
    seedBundle,
    seedCacheSql,
    derivedSql,
    divkitScreens,
    hostRuntimeJs,
  } = params

  const omnishellAndroidRel = path.relative(outDir, path.join(omnishellDir, 'android')).replaceAll(path.sep, '/')
  const pkgPath = applicationId.replaceAll('.', '/')
  const kotlinDir = path.join(outDir, 'app/src/main/kotlin', pkgPath)
  const assetsDir = path.join(outDir, 'app/src/main/assets')
  const screensAssetsDir = path.join(assetsDir, 'screens')
  const resValuesDir = path.join(outDir, 'app/src/main/res/values')

  await Deno.mkdir(kotlinDir, { recursive: true })
  await Deno.mkdir(screensAssetsDir, { recursive: true })
  await Deno.mkdir(resValuesDir, { recursive: true })

  await Deno.writeTextFile(
    path.join(outDir, 'settings.gradle.kts'),
    `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "${appName}-android"
includeBuild("${omnishellAndroidRel}")
include(":app")
`,
  )

  await Deno.writeTextFile(
    path.join(outDir, 'build.gradle.kts'),
    `plugins {
    id("com.android.application") version "8.7.3" apply false
    kotlin("android") version "2.1.0" apply false
}
`,
  )

  await Deno.writeTextFile(
    path.join(outDir, 'gradle.properties'),
    `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
`,
  )

  await Deno.writeTextFile(
    path.join(outDir, 'app/build.gradle.kts'),
    `plugins {
    id("com.android.application")
    kotlin("android")
}

android {
    namespace = "${applicationId}"
    compileSdk = 35

    defaultConfig {
        // Preserves Play App Signing identity for seamless TWA-to-DivKit upgrades.
        applicationId = "${applicationId}"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("ANDROID_VERSION_CODE")?.toIntOrNull() ?: 2)
        versionName = (System.getenv("ANDROID_VERSION_NAME") ?: "2.0.0")
    }

    signingConfigs {
        create("release") {
            val ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (!ksPath.isNullOrBlank()) {
                storeFile = file(ksPath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("com.pronto:omnishell")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
`,
  )

  const appLinksBlock = domain
    ? `
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="${domain}" />
            </intent-filter>`
    : ''

  await Deno.writeTextFile(
    path.join(outDir, 'app/src/main/AndroidManifest.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />

    <application
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:allowBackup="false">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTask"
            android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|uiMode|locale|layoutDirection">${appLinksBlock}
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${scheme}" android:host="auth" android:pathPrefix="/callback" />
                <data android:scheme="${scheme}" android:host="print" android:pathPrefix="/return" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`,
  )

  await Deno.writeTextFile(
    path.join(resValuesDir, 'strings.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${displayName}</string>
</resources>
`,
  )

  await Deno.writeTextFile(
    path.join(kotlinDir, 'MainActivity.kt'),
    `package ${applicationId}

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import com.pronto.omnishell.OmnishellConfig
import com.pronto.omnishell.QuickJsOmnishellEngine
import com.pronto.omnishell.bridge.AndroidPrintManagerHandler
import com.pronto.omnishell.bridge.AuthBridge
import com.pronto.omnishell.bridge.CustomTabsCheckoutHandler
import com.pronto.omnishell.bridge.EncryptedPrefsSessionStore
import com.pronto.omnishell.bridge.NetworkBridge
import com.pronto.omnishell.bridge.PrintBridge
import com.pronto.omnishell.bridge.StorageBridge
import com.pronto.omnishell.divkit.OmnishellDivKitHost
import com.pronto.omnishell.security.ManifestVerifier
import java.io.File

class MainActivity : AppCompatActivity() {
    private lateinit var storageBridge: StorageBridge
    private lateinit var networkBridge: NetworkBridge
    private lateinit var authBridge: AuthBridge
    private lateinit var printBridge: PrintBridge
    private lateinit var divKitHost: OmnishellDivKitHost
    private lateinit var engine: QuickJsOmnishellEngine

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val dbFile = File(filesDir, "${appName}-omnishell.sqlite")
        val firstBoot = !dbFile.exists()
        storageBridge = StorageBridge.openFile(dbFile.absolutePath)
        if (firstBoot) {
            seedOfflineStorage()
        }

        val sessionStore = EncryptedPrefsSessionStore.create(this)
        networkBridge = NetworkBridge(origin = ORIGIN)
        authBridge = AuthBridge(
            sessionStore = sessionStore,
            networkBridge = networkBridge,
            storageBridge = storageBridge
        )
        printBridge = PrintBridge(
            networkBridge = networkBridge,
            authBridge = authBridge,
            printHandler = AndroidPrintManagerHandler(this),
            checkoutHandler = CustomTabsCheckoutHandler(this)
        )
        divKitHost = OmnishellDivKitHost(
            actionCallback = { actionId, payloadJson ->
                engine.dispatchAction(actionId, payloadJson)
            },
            printBridge = printBridge
        )
        syncDisplayConfiguration(resources.configuration)

        val signedEntry = assets.open("seed-bundle.json").bufferedReader().use { it.readText() }
        ManifestVerifier.verifyKeyLength(PINNED_PUBLIC_KEY_B64)

        engine = QuickJsOmnishellEngine(
            config = OmnishellConfig(origin = ORIGIN),
            storageBridge = storageBridge,
            networkBridge = networkBridge,
            authBridge = authBridge,
            printBridge = printBridge,
            renderCallback = { cardJson, patchJson ->
                runOnUiThread {
                    if (cardJson != null) divKitHost.applyCard(cardJson)
                    if (patchJson != null) divKitHost.applyPatch(patchJson)
                }
            }
        )
        val divView = divKitHost.mountView(this)
        setContentView(divView)
        intent?.dataString?.let { handleIncomingUrl(it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.dataString?.let { handleIncomingUrl(it) }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        syncDisplayConfiguration(newConfig)
    }

    private fun syncDisplayConfiguration(cfg: Configuration) {
        val dark = (cfg.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val rtl = cfg.layoutDirection == View.LAYOUT_DIRECTION_RTL
        divKitHost.configureDisplay(
            viewportWidthDp = cfg.screenWidthDp,
            theme = if (dark) "dark" else "light",
            direction = if (rtl) "rtl" else "ltr"
        )
    }

    private fun handleIncomingUrl(rawUrl: String) {
        if (PrintBridge.parsePrintReturnUrl(rawUrl, "${scheme}") != null) {
            printBridge.handleReturnUrl(
                rawUrl = rawUrl,
                origin = ORIGIN,
                expectedScheme = "${scheme}",
                onComplete = { payload -> engine.dispatchAction("ORDER_RECHECK", payload) },
                onError = { err -> throw IllegalStateException(err) }
            )
        }
    }

    private fun seedOfflineStorage() {
        val cacheSql = assets.open("seed-cache.sql").bufferedReader().use { it.readText() }
        val derived = assets.open("derived.sql").bufferedReader().use { it.readText() }
        storageBridge.sqlExec(cacheSql, null)
        storageBridge.sqlExec(derived, null)
    }

    override fun onDestroy() {
        if (::engine.isInitialized) engine.close()
        if (::storageBridge.isInitialized) storageBridge.close()
        super.onDestroy()
    }

    companion object {
        const val ORIGIN = "${origin}"
        const val PINNED_PUBLIC_KEY_B64 = "${publicKeyBase64}"
        const val NATIVE_BRIDGE_ABI = "${nativeBridgeAddress}"
    }
}
`,
  )

  await Deno.writeTextFile(
    path.join(assetsDir, 'manifest-signing.json'),
    JSON.stringify(
      {
        applicationId,
        certFingerprints,
        origin,
        scheme,
        publicKeyBase64,
        signatureBase64,
        nativeBridgeAddress,
      },
      null,
      2,
    ) + '\n',
  )
  await Deno.writeTextFile(path.join(assetsDir, 'seed-bundle.json'), JSON.stringify(seedBundle, null, 2) + '\n')
  await Deno.writeTextFile(path.join(assetsDir, 'seed-cache.sql'), seedCacheSql)
  await Deno.writeTextFile(path.join(assetsDir, 'derived.sql'), derivedSql)
  await Deno.writeTextFile(path.join(assetsDir, 'omnishell-runtime.js'), hostRuntimeJs)
  for (const [screenName, divkit] of Object.entries(divkitScreens)) {
    await Deno.writeTextFile(path.join(screensAssetsDir, `${screenName}.divkit.json`), JSON.stringify(divkit))
  }
}

async function emitIosProject(params: {
  outDir: string
  omnishellDir: string
  appName: string
  displayName: string
  bundleIdentifier: string
  domain: string
  origin: string
  scheme: string
  publicKeyBase64: string
  signatureBase64: string
  nativeBridgeAddress: string
  seedBundle: NativeSeedBundle
  seedCacheSql: string
  derivedSql: string
  divkitScreens: Record<string, unknown>
  hostRuntimeJs: string
}): Promise<void> {
  const {
    outDir,
    omnishellDir,
    appName,
    displayName,
    bundleIdentifier,
    domain,
    origin,
    scheme,
    publicKeyBase64,
    signatureBase64,
    nativeBridgeAddress,
    seedBundle,
    seedCacheSql,
    derivedSql,
    divkitScreens,
    hostRuntimeJs,
  } = params

  const targetName = `${pascalCase(appName)}App`
  const mainTargetName = `${targetName}Main`
  const packagesDir = path.join(outDir, 'Packages')
  const omnishellLink = path.join(packagesDir, 'Omnishell')
  const omnishellIosRelFromPackages = path.relative(packagesDir, path.join(omnishellDir, 'ios')).replaceAll(path.sep, '/')
  const sourcesDir = path.join(outDir, 'Sources', targetName)
  const mainSourcesDir = path.join(outDir, 'Sources', mainTargetName)
  const resourcesDir = path.join(sourcesDir, 'Resources')
  const screensDir = path.join(resourcesDir, 'screens')
  const appConfigDir = path.join(outDir, 'App')
  const xcconfigDir = path.join(outDir, 'Config')

  await Deno.mkdir(packagesDir, { recursive: true })
  await Deno.remove(omnishellLink, { recursive: true }).catch(() => {})
  await Deno.symlink(omnishellIosRelFromPackages, omnishellLink)
  await Deno.mkdir(screensDir, { recursive: true })
  await Deno.mkdir(mainSourcesDir, { recursive: true })
  await Deno.mkdir(appConfigDir, { recursive: true })
  await Deno.mkdir(xcconfigDir, { recursive: true })

  await Deno.writeTextFile(
    path.join(outDir, 'Package.swift'),
    `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "${targetName}",
    platforms: [
        .iOS(.v16),
        .macOS(.v14)
    ],
    products: [
        .library(name: "${targetName}", targets: ["${targetName}"]),
        .executable(name: "${mainTargetName}", targets: ["${mainTargetName}"])
    ],
    dependencies: [
        .package(path: "Packages/Omnishell")
    ],
    targets: [
        .target(
            name: "${targetName}",
            dependencies: [
                .product(name: "Omnishell", package: "Omnishell")
            ],
            path: "Sources/${targetName}",
            resources: [
                .copy("Resources")
            ]
        ),
        .executableTarget(
            name: "${mainTargetName}",
            dependencies: [
                .target(name: "${targetName}"),
                .product(name: "Omnishell", package: "Omnishell")
            ],
            path: "Sources/${mainTargetName}"
        )
    ],
    swiftLanguageModes: [.v5]
)
`,
  )

  await Deno.writeTextFile(
    path.join(xcconfigDir, 'App.xcconfig'),
    `PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}
PRODUCT_NAME = ${displayName}
MARKETING_VERSION = 2.0.0
CURRENT_PROJECT_VERSION = 2
IPHONEOS_DEPLOYMENT_TARGET = 16.0
CODE_SIGN_ENTITLEMENTS = App/App.entitlements
INFOPLIST_FILE = App/Info.plist
SUPPORTS_MACCATALYST = NO
TARGETED_DEVICE_FAMILY = 1,2
`,
  )

  await Deno.writeTextFile(
    path.join(appConfigDir, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>${displayName}</string>
    <key>CFBundleIdentifier</key>
    <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    <key>CFBundleName</key>
    <string>${displayName}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$(MARKETING_VERSION)</string>
    <key>CFBundleVersion</key>
    <string>$(CURRENT_PROJECT_VERSION)</string>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>${bundleIdentifier}</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>${scheme}</string>
            </array>
        </dict>
    </array>
    <key>NSLocationWhenInUseUsageDescription</key>
    <string>${displayName} uses your location when choosing a print delivery address on the map.</string>
    <key>UISupportedInterfaceOrientations</key>
    <array>
        <string>UIInterfaceOrientationPortrait</string>
        <string>UIInterfaceOrientationLandscapeLeft</string>
        <string>UIInterfaceOrientationLandscapeRight</string>
    </array>
    <key>UISupportedInterfaceOrientations~ipad</key>
    <array>
        <string>UIInterfaceOrientationPortrait</string>
        <string>UIInterfaceOrientationPortraitUpsideDown</string>
        <string>UIInterfaceOrientationLandscapeLeft</string>
        <string>UIInterfaceOrientationLandscapeRight</string>
    </array>
    <key>LSRequiresIPhoneOS</key>
    <true/>
    <key>UILaunchScreen</key>
    <dict/>
</dict>
</plist>
`,
  )

  const associatedDomainsXml = domain
    ? `    <key>com.apple.developer.associated-domains</key>
    <array>
        <string>applinks:${domain}</string>
        <string>webcredentials:${domain}</string>
    </array>
`
    : ''

  await Deno.writeTextFile(
    path.join(appConfigDir, 'App.entitlements'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${associatedDomainsXml}    <key>com.apple.developer.applesignin</key>
    <array>
        <string>Default</string>
    </array>
</dict>
</plist>
`,
  )

  await Deno.writeTextFile(
    path.join(sourcesDir, `${targetName}.swift`),
    `import Foundation
import Omnishell
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
#endif

public final class ${targetName}Coordinator: @unchecked Sendable {
    public static let bundleIdentifier = "${bundleIdentifier}"
    public static let origin = URL(string: "${origin}")!
    public static let scheme = "${scheme}"
    public static let pinnedPublicKeyBase64 = "${publicKeyBase64}"
    public static let nativeBridgeAbi = "${nativeBridgeAddress}"

    public let sqliteDb: CSystemSqliteDatabase
    public let storageBridge: StorageBridge
    public let networkBridge: NetworkBridge
    public let authBridge: AuthBridge
    public let printBridge: PrintBridge
    public let divKitHost: OmnishellDivKitHost
    public let engine: JavaScriptCoreOmnishellEngine
    public let resourcesUrl: URL

    public init(databasePath: String? = nil, sessionStore: SecureSessionStore? = nil) throws {
        let resolvedResources = try Self.resolveResourcesUrl()
        self.resourcesUrl = resolvedResources

        let resolvedDbPath: String
        if let databasePath {
            resolvedDbPath = databasePath
        } else {
            let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            try FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
            resolvedDbPath = appSupport.appendingPathComponent("${appName}-omnishell.sqlite").path
        }
        let firstBoot = !FileManager.default.fileExists(atPath: resolvedDbPath)
        let db = try CSystemSqliteDatabase(path: resolvedDbPath)
        let kv = try SqliteKeyValueStore(db: db)
        let storage = StorageBridge(sqlDatabase: db, keyValueStore: kv)
        self.sqliteDb = db
        self.storageBridge = storage

        if firstBoot {
            try Self.seedOfflineStorage(into: storage, resourcesUrl: resolvedResources)
        } else {
            let existingDecks = storage.sqlQuery(
                sql: "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name = 'mecha_shape_row'",
                paramsJson: nil
            )
            if !existingDecks.contains("1") {
                try Self.seedOfflineStorage(into: storage, resourcesUrl: resolvedResources)
            }
        }

        let store = sessionStore ?? KeyValueSessionStore(storageBridge: storage)
        let net = NetworkBridge()
        let auth = AuthBridge(sessionStore: store)
        let prt = PrintBridge(networkBridge: net, origin: Self.origin.absoluteString)
        self.networkBridge = net
        self.authBridge = auth
        self.printBridge = prt

        let host = OmnishellDivKitHost()
        host.resourcesUrl = resolvedResources
        host.origin = Self.origin.absoluteString
        host.printBridge = prt
        host.registerCustomFactory(FlipCardDivCustomBlockFactory())
        host.registerCustomFactory(PrintRealmDivCustomBlockFactory(printBridge: prt))
        self.divKitHost = host

        let runtimeScript = try String(
            contentsOf: resolvedResources.appendingPathComponent("omnishell-runtime.js"),
            encoding: .utf8
        )
        let jsEngine = JavaScriptCoreOmnishellEngine(
            networkBridge: net,
            storageBridge: storage,
            initialScript: runtimeScript,
            authBridge: auth,
            origin: Self.origin.absoluteString,
            printBridge: prt,
            resourcesUrl: resolvedResources
        )
        jsEngine.onAstChanged = { [weak jsEngine] ast in
            if Thread.isMainThread {
                _ = host.render(astJson: ast) { actionUri in
                    jsEngine?.dispatchAction(actionUri)
                }
            } else {
                DispatchQueue.main.async {
                    _ = host.render(astJson: ast) { actionUri in
                        jsEngine?.dispatchAction(actionUri)
                    }
                }
            }
        }
        jsEngine.onPatchChanged = { patchJson in
            if Thread.isMainThread {
                _ = host.applyPatch(patchJson: patchJson)
            } else {
                DispatchQueue.main.async {
                    _ = host.applyPatch(patchJson: patchJson)
                }
            }
        }
        jsEngine.onVariableChanged = { name, value in
            if Thread.isMainThread {
                host.updateVariable(name: name, value: value)
            } else {
                DispatchQueue.main.async {
                    host.updateVariable(name: name, value: value)
                }
            }
        }
        try jsEngine.start()
        self.engine = jsEngine

        let cliArgs = CommandLine.arguments
        var argIdx = 1
        while argIdx + 1 < cliArgs.count {
            if cliArgs[argIdx] == "--url", let launchUrl = URL(string: cliArgs[argIdx + 1]) {
                handleOpenURL(launchUrl)
                argIdx += 2
            } else {
                argIdx += 1
            }
        }
    }

    public func updateDisplay(viewportWidthDp: Int, isDark: Bool, isRtl: Bool) {
        divKitHost.configureDisplay(
            viewportWidthDp: viewportWidthDp,
            themeMode: isDark ? "dark" : "light",
            layoutDirection: isRtl ? "rtl" : "ltr"
        )
    }

    public func handleOpenURL(_ url: URL) {
        let raw = url.absoluteString
        if PrintBridge.parsePrintReturnDeepLink(raw) != nil {
            let bearer = (try? authBridge.loadSession())?.token
            printBridge.handlePrintReturnDeepLink(raw, bearerToken: bearer) { [engine] result in
                if case .success((let link, _)) = result {
                    engine.dispatchAction("ORDER_RECHECK:\\(link.orderId)")
                }
            }
            return
        }
        if url.scheme == Self.scheme, url.host == "event" {
            let actName = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let q = url.query.map { "?\\($0)" } ?? ""
            engine.dispatchAction("pronto://event/\\(actName)\\(q)")
            return
        }
        if url.scheme == Self.scheme, url.host == "set_variable" {
            let q = url.query.map { "?\\($0)" } ?? ""
            engine.dispatchAction("div-action://set_variable\\(q)")
            return
        }
        let fullPath: String
        if url.scheme == Self.scheme, let host = url.host, !host.isEmpty {
            let tail = url.path
            fullPath = tail.isEmpty || tail == "/" ? "/\\(host)" : "/\\(host)\\(tail)"
        } else {
            fullPath = url.path.isEmpty ? "/" : url.path
        }
        let encodedPath = fullPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "/"
        let encodedQuery = (url.query ?? "").addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        engine.dispatchAction("pronto://event/DEEPLINK?path=\\(encodedPath)&query=\\(encodedQuery)")
    }

    public static func resolveResourcesUrl() throws -> URL {
        if let mainRes = Bundle.main.url(forResource: "Resources", withExtension: nil) {
            return mainRes
        }
        if let subBundleUrl = Bundle.main.url(forResource: "${targetName}_${targetName}", withExtension: "bundle"),
           let subBundle = Bundle(url: subBundleUrl),
           let subRes = subBundle.url(forResource: "Resources", withExtension: nil) {
            return subRes
        }
        if let modRes = Bundle.module.url(forResource: "Resources", withExtension: nil) {
            return modRes
        }
        throw NSError(
            domain: "${targetName}",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Missing bundled Resources directory"]
        )
    }

    public static func seedOfflineStorage(into storage: StorageBridge, resourcesUrl: URL? = nil) throws {
        let resolved = try resourcesUrl ?? resolveResourcesUrl()
        let entryData = try Data(contentsOf: resolved.appendingPathComponent("seed-bundle.json"))
        if let json = try JSONSerialization.jsonObject(with: entryData) as? [String: Any],
           let entryHtml = json["entryHtml"] as? String {
            _ = try ManifestVerifier.verifyEntryHtml(entryHtml: entryHtml, publicKeyBase64: pinnedPublicKeyBase64)
        }
        let cacheSql = try String(contentsOf: resolved.appendingPathComponent("seed-cache.sql"), encoding: .utf8)
        let derivedSql = try String(contentsOf: resolved.appendingPathComponent("derived.sql"), encoding: .utf8)
        _ = storage.sqlExec(sql: cacheSql, paramsJson: nil)
        _ = storage.sqlExec(sql: derivedSql, paramsJson: nil)
    }
}

#if canImport(SwiftUI) && canImport(UIKit)
@available(iOS 16.0, *)
public struct ${targetName}RootView: View {
    private let coordinator: ${targetName}Coordinator

    public init() {
        do {
            self.coordinator = try ${targetName}Coordinator()
        } catch {
            fatalError("${targetName}Coordinator boot failed: \\(error)")
        }
    }

    public var body: some View {
        OmnishellNativeAppView(
            viewModel: OmnishellStoreViewModel(
                storageBridge: coordinator.storageBridge,
                networkBridge: coordinator.networkBridge,
                authBridge: coordinator.authBridge,
                printBridge: coordinator.printBridge,
                divKitHost: coordinator.divKitHost,
                resourcesUrl: coordinator.resourcesUrl,
                origin: ${targetName}Coordinator.origin.absoluteString,
                engine: coordinator.engine
            )
        )
        .onOpenURL { url in
            coordinator.handleOpenURL(url)
        }
    }
}
#endif
`,
  )

  await Deno.writeTextFile(
    path.join(mainSourcesDir, 'AppMain.swift'),
    `import Foundation
import ${targetName}
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 16.0, *)
@main
struct ${mainTargetName}: App {
    var body: some Scene {
        WindowGroup {
            ${targetName}RootView()
        }
    }
}
#else
@main
struct ${mainTargetName} {
    static func main() {
        _ = ${targetName}Coordinator.bundleIdentifier
    }
}
#endif
`,
  )

  const simBuildScriptPath = path.join(outDir, 'build-simulator-app.sh')
  await Deno.writeTextFile(
    simBuildScriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR="\${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export OMNISHELL_IOS_DIVKIT=1
ARCH="\${SIM_ARCH:-$(uname -m)}"
TRIPLE="\${ARCH}-apple-ios17.0-simulator"
SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"

xcrun swift build --triple "\$TRIPLE" --sdk "\$SDK_PATH" --product "${mainTargetName}"

BIN_DIR="\$(xcrun swift build --triple "\$TRIPLE" --sdk "\$SDK_PATH" --product "${mainTargetName}" --show-bin-path)"
APP_BUNDLE=".build/Simulator/${displayName}.app"
rm -rf "\$APP_BUNDLE"
mkdir -p "\$APP_BUNDLE"

cp "\$BIN_DIR/${mainTargetName}" "\$APP_BUNDLE/${mainTargetName}"
if [ -d "\$BIN_DIR/${targetName}_${targetName}.bundle" ]; then
  cp -R "\$BIN_DIR/${targetName}_${targetName}.bundle" "\$APP_BUNDLE/"
fi

sed \\
  -e "s/\\\$(PRODUCT_BUNDLE_IDENTIFIER)/${bundleIdentifier}/g" \\
  -e "s/\\\$(MARKETING_VERSION)/2.5.0/g" \\
  -e "s/\\\$(CURRENT_PROJECT_VERSION)/2/g" \\
  App/Info.plist > "\$APP_BUNDLE/Info.plist"

/usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string ${mainTargetName}" "\$APP_BUNDLE/Info.plist" 2>/dev/null || \\
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable ${mainTargetName}" "\$APP_BUNDLE/Info.plist"
/usr/libexec/PlistBuddy -c "Add :UIDeviceFamily array" "\$APP_BUNDLE/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :UIDeviceFamily:0 integer 1" "\$APP_BUNDLE/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :UIDeviceFamily:1 integer 2" "\$APP_BUNDLE/Info.plist" 2>/dev/null || true

codesign --force --sign - "\$APP_BUNDLE"
echo "\$PWD/\$APP_BUNDLE"
`,
  )
  await Deno.chmod(simBuildScriptPath, 0o755)

  await Deno.writeTextFile(
    path.join(resourcesDir, 'manifest-signing.json'),
    JSON.stringify(
      {
        bundleIdentifier,
        origin,
        scheme,
        publicKeyBase64,
        signatureBase64,
        nativeBridgeAddress,
      },
      null,
      2,
    ) + '\n',
  )
  await Deno.writeTextFile(path.join(resourcesDir, 'seed-bundle.json'), JSON.stringify(seedBundle, null, 2) + '\n')
  await Deno.writeTextFile(path.join(resourcesDir, 'seed-cache.sql'), seedCacheSql)
  await Deno.writeTextFile(path.join(resourcesDir, 'derived.sql'), derivedSql)
  await Deno.writeTextFile(path.join(resourcesDir, 'omnishell-runtime.js'), hostRuntimeJs)
  for (const [screenName, divkit] of Object.entries(divkitScreens)) {
    await Deno.writeTextFile(path.join(screensDir, `${screenName}.divkit.json`), JSON.stringify(divkit))
  }
}

export async function buildNativeApp(options: BuildNativeOptions): Promise<BuildNativeResult> {
  const app = path.resolve(options.appDir)
  const omnishell = path.resolve(options.omnishellDir)
  const platform = options.platform
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error(`--platform must be android or ios, got ${JSON.stringify(platform)}`)
  }
  let out = path.resolve(options.outDir ?? path.join(app, `dist/${platform}`))
  const domain = (options.domain ?? '').trim()
  if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new Error(`--domain ${JSON.stringify(domain)} is no host name`)
  }

  const shell = JSON.parse(await Deno.readTextFile(path.join(app, 'shell/shell.json'))) as {
    app?: string
    brand?: { label?: string }
    native?: NativePlatform[]
    routes?: Array<{ path: string; paths?: Record<string, string>; files: { html: string } }>
    i18n?: { default?: string; locales?: Record<string, unknown> }
    units?: Record<string, { role?: string; isolation?: string; subdomain?: string; src?: string }>
  }
  if (!shell.native?.includes(platform)) {
    throw new Error(`${app} declares no ${platform} host (code.capabilities.native)`)
  }
  const subdomains = realmSubdomains(shell.units)
  if (subdomains.length && !domain) {
    throw new Error(`realm subdomains ${subdomains.join(', ')} require --domain`)
  }

  const appName = shell.app ?? path.basename(app)
  const displayName = shell.brand?.label ?? pascalCase(appName)
  const scheme = appName.toLowerCase().replace(/[^a-z0-9+.-]/g, '')
  const origin = domain ? `https://${domain}` : `https://${appName}.local`

  const addresses = await releaseAddresses(omnishell)
  const iceServers = addresses.parseIceServers(options.iceServersJson ?? DEFAULT_ICE_SERVERS_JSON)
  const hatches = await readEdgeHatches(app)

  const staticsOut = await new Deno.Command('cue', {
    args: ['export', '.', '-e', '{statics: terminal.surface.statics, clusterStatics: cluster.meta.statics}', '--out', 'json'],
    cwd: app,
    stdout: 'piped',
    stderr: 'inherit',
  }).output()
  if (!staticsOut.success) throw new Error('cue export of public assets failed')
  const { statics: terminalStatics, clusterStatics } = JSON.parse(new TextDecoder().decode(staticsOut.stdout)) as {
    statics: StaticAsset[]
    clusterStatics: StaticAsset[]
  }

  await Deno.remove(out, { recursive: true }).catch((e) => {
    if (!(e instanceof Deno.errors.NotFound)) throw e
  })
  const webDir = path.join(out, 'web')
  await Deno.mkdir(webDir, { recursive: true })
  out = await Deno.realPath(out)

  await writeEdgeAssets(app, omnishell, webDir, [...terminalStatics, ...clusterStatics])
  await applyHatchAttributes(webDir, hatches)

  const { projectAppNative } = await import(pathToFileURL(path.join(omnishell, 'project-native.ts')).href) as {
    projectAppNative: (appDir: URL, opts?: { origin?: string; viewportWidthDp?: number }) => Promise<{ screens: Record<string, { divkit: unknown }> }>
  }
  const { emitNativeHostRuntimeJs } = await import(pathToFileURL(path.join(omnishell, 'runtime/reconciler.ts')).href) as {
    emitNativeHostRuntimeJs: () => string
  }
  const projected = await projectAppNative(pathToFileURL(app + '/'), { origin, viewportWidthDp: 390 })
  const hostRuntimeJs = emitNativeHostRuntimeJs()
  const divkitScreens: Record<string, unknown> = {}
  await Deno.mkdir(path.join(webDir, 'shell/screens'), { recursive: true })
  for (const [screenName, spec] of Object.entries(projected.screens)) {
    divkitScreens[screenName] = spec.divkit
    await Deno.writeTextFile(path.join(webDir, `shell/screens/${screenName}.divkit.json`), JSON.stringify(spec.divkit))
  }

  const nativeBridgeBytes = await collectNativeBridgeBytes(omnishell)
  const { privateKey, publicKey, publicKeyBase64 } = await resolveSigningKeys(options.ed25519PrivateKeyPkcs8)
  await addressEdgeAssets(addresses, webDir, {
    iceServers,
    domain: domain || undefined,
    nativeBridge: nativeBridgeBytes,
    ed25519PrivateKey: privateKey,
  })
  await holdIceServers(builtRelease(webDir), iceServers, webDir)

  const rawEntryHtml = await Deno.readTextFile(path.join(webDir, 'index.html'))
  const stampedEntryHtml = stampProntoKept(rawEntryHtml)
  await Deno.writeTextFile(path.join(webDir, 'index.html'), stampedEntryHtml)

  const scriptMatch = /<script\b([^>]*\bid=["']pronto-assets["'][^>]*)>([\s\S]*?)<\/script>/i.exec(stampedEntryHtml)
  if (!scriptMatch) throw new Error('Addressed entry HTML is missing #pronto-assets')
  const [, attrStr, manifestPayload] = scriptMatch
  const sigMatch = /\bdata-signature=["']([^"']+)["']/i.exec(attrStr)
  if (!sigMatch?.[1]) throw new Error('#pronto-assets is missing Ed25519 data-signature')
  const signatureBase64 = sigMatch[1]
  const sigValid = await crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    new Uint8Array(base64ToBytes(signatureBase64)),
    new TextEncoder().encode(manifestPayload),
  )
  if (!sigValid) throw new Error('Self-verification of Ed25519 #pronto-assets signature failed')

  const manifest = JSON.parse(manifestPayload) as { imports: Record<string, string>; screens?: Record<string, string[]> }
  const nativeBridgeAddress = manifest.imports['/@native/bridge'] ?? ''
  if (!nativeBridgeAddress) throw new Error('#pronto-assets is missing /@native/bridge ABI entry')

  const addressedAssets: Record<string, { body: string; contentType: string }> = {}
  const decoder = new TextDecoder('utf-8', { fatal: false })
  for (const [logicalKey, immutableUrl] of Object.entries(manifest.imports)) {
    if (logicalKey === '/@native/bridge') {
      addressedAssets[immutableUrl] = {
        body: JSON.stringify({ abi: immutableUrl }),
        contentType: 'application/json; charset=utf-8',
      }
      continue
    }
    if (logicalKey.startsWith('/docs/') || !TEXT_RUNTIME_ASSET_RE.test(logicalKey)) {
      continue
    }
    const relPath = decodeURIComponent(immutableUrl).replace(/^\/+/, '')
    const bytes = await Deno.readFile(path.join(webDir, relPath))
    addressedAssets[immutableUrl] = {
      body: decoder.decode(bytes),
      contentType: contentTypeForAsset(immutableUrl),
    }
  }

  const entryPathSet = new Set<string>(['/'])
  for (const locale of Object.keys(shell.i18n?.locales ?? {})) {
    entryPathSet.add(`/${locale}`)
    entryPathSet.add(`/${locale}/`)
  }
  for (const route of shell.routes ?? []) {
    if (!route.path.includes(':')) entryPathSet.add(route.path)
    for (const locPath of Object.values(route.paths ?? {})) {
      if (!locPath.includes(':')) entryPathSet.add(locPath)
    }
  }
  const entryPaths = [...entryPathSet].sort()

  const extraDerived = options.derivedFile ? await Deno.readTextFile(path.resolve(options.derivedFile)) : undefined
  const entitySeeds = await exportEntitySeeds(app)
  const { sql: derivedSql, seededShapes } = renderDerivedSql(entitySeeds, extraDerived)
  const seedCacheSql = renderSeedCacheSql(origin, entryPaths, stampedEntryHtml, addressedAssets)

  const seedBundle: NativeSeedBundle = {
    app: appName,
    platform,
    origin,
    scheme,
    publicKeyBase64,
    signatureBase64,
    nativeBridgeAddress,
    entryPaths,
    entryHtml: stampedEntryHtml,
    addressedAssets,
    seededShapes,
  }

  if (platform === 'android') {
    const { applicationId, certFingerprints } = await discoverAndroidTarget(webDir, options.androidPackage)
    await emitAndroidProject({
      outDir: out,
      omnishellDir: omnishell,
      appName,
      displayName,
      applicationId,
      certFingerprints,
      domain,
      origin,
      scheme,
      publicKeyBase64,
      signatureBase64,
      nativeBridgeAddress,
      seedBundle,
      seedCacheSql,
      derivedSql,
      divkitScreens,
      hostRuntimeJs,
    })
    return {
      outDir: out,
      platform,
      applicationId,
      publicKeyBase64,
      signatureBase64,
      nativeBridgeAddress,
      entryPaths,
      addressedCount: Object.keys(addressedAssets).length,
      seededShapes,
    }
  }

  const bundleIdentifier = await discoverIosBundleId(webDir, options.iosBundleId)
  await emitIosProject({
    outDir: out,
    omnishellDir: omnishell,
    appName,
    displayName,
    bundleIdentifier,
    domain,
    origin,
    scheme,
    publicKeyBase64,
    signatureBase64,
    nativeBridgeAddress,
    seedBundle,
    seedCacheSql,
    derivedSql,
    divkitScreens,
    hostRuntimeJs,
  })
  return {
    outDir: out,
    platform,
    bundleIdentifier,
    publicKeyBase64,
    signatureBase64,
    nativeBridgeAddress,
    entryPaths,
    addressedCount: Object.keys(addressedAssets).length,
    seededShapes,
  }
}

if (import.meta.main) {
  function fail(msg: string): never {
    console.error(`native: ${msg}`)
    Deno.exit(1)
  }

  const args = Deno.args.slice()
  const usage =
    'usage: native.ts <appDir> --platform <android|ios> --omnishell <dir> --mecha <dir> [--out <dir>] [--domain <host>] [--derived <file>] [--android-package <id>] [--ios-bundle-id <id>] [--ice-servers <json>]'
  const appDir = args.shift() ?? fail(usage)
  const flags: Record<string, string> = {}
  while (args.length) {
    const flag = args.shift()!
    flags[flag] = args.shift() ?? fail(`${flag} takes a value`)
  }
  const allowed = new Set([
    '--platform',
    '--omnishell',
    '--mecha',
    '--out',
    '--domain',
    '--derived',
    '--android-package',
    '--ios-bundle-id',
    '--ice-servers',
  ])
  for (const flag of Object.keys(flags)) {
    if (!allowed.has(flag)) fail(`unknown flag ${flag}`)
  }
  const platform = flags['--platform'] as NativePlatform | undefined
  if (platform !== 'android' && platform !== 'ios') fail('--platform must be android or ios')
  const omnishellDir = flags['--omnishell'] ?? fail('--omnishell names the interpreter root')
  const mechaDir = flags['--mecha'] ?? fail('--mecha names the mecha root')

  await buildNativeApp({
    appDir,
    platform,
    omnishellDir,
    mechaDir,
    outDir: flags['--out'],
    domain: flags['--domain'],
    derivedFile: flags['--derived'],
    androidPackage: flags['--android-package'],
    iosBundleId: flags['--ios-bundle-id'],
    iceServersJson: flags['--ice-servers'],
  })
}
