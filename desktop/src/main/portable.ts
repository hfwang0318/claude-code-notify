import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Detect a zip/unpacked build. NSIS installs do not carry these markers, so
 * `electron-updater` must not be allowed to run its installer from a portable
 * folder.
 */
export function detectPortableBuild(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): boolean {
  if (env.PORTABLE_EXECUTABLE_DIR) return true
  try {
    const directory = dirname(execPath)
    return (
      exists(join(directory, 'RUN-ME.bat')) || exists(join(directory, 'portable.marker'))
    )
  } catch {
    return false
  }
}
