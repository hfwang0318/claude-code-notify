/**
 * Optional macOS notarization hook.
 *
 * Set APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID to enable.
 * Without them the build still succeeds (useful for local dev builds).
 */
exports.default = async function notarize(context) {
  if (process.platform !== 'darwin' || context.electronPlatformName !== 'darwin') return
  if (process.env.SKIP_NOTARIZE === '1') return
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.log('[notarize] skipped: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set')
    return
  }
  const { notarize } = require('@electron/notarize')
  const appPath = context.appOutDir
  console.log(`[notarize] submitting ${appPath}`)
  await notarize({
    appBundleId: 'com.claude-notify.app',
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID
  })
}
